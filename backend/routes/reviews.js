const express = require('express');
const router = express.Router();
const Review = require('../models/Review');
const Project = require('../models/Project');
const Proposal = require('../models/Proposal');
const User = require('../models/User');
const { protect } = require('../middleware/authMiddleware');
const { isValidObjectId, parsePagination, sendError } = require('../utils/validate');

router.get('/project/:projectId', async (req, res) => {
  try {
    if (!isValidObjectId(req.params.projectId)) {
      return res.status(400).json({ message: 'Invalid project ID.' });
    }
    if (
      (req.query.page !== undefined && typeof req.query.page !== 'string')
      || (req.query.limit !== undefined && typeof req.query.limit !== 'string')
    ) {
      return res.status(400).json({ message: 'Query parameters must be strings.' });
    }
    const { page, limit } = parsePagination({ ...req.query, limit: req.query.limit || '50' }, { maxLimit: 50 });

    // Reviews of private or unfinished listings must not be publicly readable.
    const project = await Project.findById(req.params.projectId).select('status visibility');
    if (!project) return res.status(404).json({ message: 'Project not found' });
    if (['draft', 'cancelled'].includes(project.status) || project.visibility !== 'public') {
      return res.status(404).json({ message: 'Project not found' });
    }

    const reviews = await Review.find({ project: req.params.projectId })
      .populate('reviewer', 'name avatar')
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(limit);
    res.json({ reviews });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/', protect, async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ message: 'A valid request body is required.' });
    }
    const { projectId, rating, comment } = req.body;
    if (!isValidObjectId(projectId)) {
      return res.status(400).json({ message: 'Invalid project ID.' });
    }
    const numericRating = Number(rating);
    if (!Number.isInteger(numericRating) || numericRating < 1 || numericRating > 5) {
      return res.status(400).json({ message: 'Rating must be an integer from 1 to 5.' });
    }
    if (typeof comment !== 'string' || !comment.trim() || comment.length > 2000) {
      return res.status(400).json({ message: 'Comment must be a non-empty string of at most 2000 characters.' });
    }
    
    const project = await Project.findById(projectId);
    if (!project) return res.status(404).json({ message: 'Project not found' });
    if (!['active', 'completed'].includes(project.status)) {
      return res.status(400).json({ message: 'Reviews are only allowed for active or completed projects.' });
    }
    
    const acceptedProposal = await Proposal.findOne({ project: project._id, status: 'accepted' });
    if (!acceptedProposal) {
      return res.status(400).json({ message: 'This project has no accepted proposal to review.' });
    }

    const isClient = project.client.toString() === req.user._id.toString();
    const isAcceptedFreelancer = acceptedProposal.freelancer.toString() === req.user._id.toString();
    if (!isClient && !isAcceptedFreelancer) {
      return res.status(403).json({ message: 'Only project participants can leave a review.' });
    }
    const revieweeId = isClient ? acceptedProposal.freelancer : project.client;

    // Cannot review twice
    const existing = await Review.findOne({ project: projectId, reviewer: req.user._id });
    if (existing) return res.status(400).json({ message: 'You have already reviewed this project' });
    
    const review = await Review.create({
      project: projectId,
      reviewer: req.user._id,
      reviewee: revieweeId,
      rating: numericRating,
      comment: comment.trim(),
    });
    
    const [stats] = await Review.aggregate([
      { $match: { reviewee: revieweeId } },
      {
        $group: {
          _id: null,
          rating: { $avg: '$rating' },
          reviewCount: { $sum: 1 },
        },
      },
    ]);
    await User.updateOne(
      { _id: revieweeId },
      { $set: { rating: stats?.rating || 0, reviewCount: stats?.reviewCount || 0 } },
    );
    
    res.status(201).json({ review });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: 'You have already reviewed this project.' });
    }
    sendError(res, error);
  }
});

module.exports = router;
