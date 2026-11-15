const express = require('express');
const router = express.Router();
const Proposal = require('../models/Proposal');
const Project = require('../models/Project');
const { protect, authorize } = require('../middleware/authMiddleware');
const { isValidObjectId, sendError } = require('../utils/validate');

router.post('/', protect, authorize('freelancer'), async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ message: 'A valid request body is required.' });
    }
    const { projectId, coverLetter, bidAmount, deliveryTime } = req.body;
    if (!isValidObjectId(projectId)) {
      return res.status(400).json({ message: 'Invalid project ID.' });
    }
    if (typeof bidAmount !== 'number' || !Number.isFinite(bidAmount) || bidAmount <= 0) {
      return res.status(400).json({ message: 'Bid amount must be a number greater than zero.' });
    }
    if (!Number.isInteger(deliveryTime) || deliveryTime < 1) {
      return res.status(400).json({ message: 'Delivery time must be an integer of at least one day.' });
    }
    if (typeof coverLetter !== 'string' || !coverLetter.trim()) {
      return res.status(400).json({ message: 'Cover letter must be a non-empty string.' });
    }
    
    const project = await Project.findById(projectId);
    if (!project) return res.status(404).json({ message: 'Project not found' });
    if (project.status !== 'open') return res.status(400).json({ message: 'Project is not open for proposals' });
    
    const existingP = await Proposal.findOne({ project: projectId, freelancer: req.user._id });
    if (existingP) return res.status(400).json({ message: 'You have already submitted a proposal for this project' });
    
    const proposal = await Proposal.create({
      project: projectId,
      freelancer: req.user._id,
      coverLetter: coverLetter.trim(),
      bidAmount,
      deliveryTime
    });
    
    await Project.updateOne({ _id: project._id }, { $inc: { proposalCount: 1 } });
    
    res.status(201).json({ proposal });
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/my', protect, authorize('freelancer'), async (req, res) => {
  try {
    const proposals = await Proposal.find({ freelancer: req.user._id })
      .populate('project', 'title budgetType budgetMin budgetMax')
      .sort('-createdAt');
    res.json({ proposals });
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/project/:projectId', protect, authorize('client'), async (req, res) => {
  try {
    if (!isValidObjectId(req.params.projectId)) {
      return res.status(400).json({ message: 'Invalid project ID.' });
    }
    const project = await Project.findById(req.params.projectId);
    if (!project) return res.status(404).json({ message: 'Project not found' });
    if (project.client.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized' });
    }
    
    const proposals = await Proposal.find({ project: req.params.projectId })
      .populate('freelancer', 'name title avatar skills rating reviewCount completedProjects')
      .sort('-createdAt');
      
    res.json({ proposals });
  } catch (error) {
    sendError(res, error);
  }
});

router.put('/:id/accept', protect, authorize('client'), async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid proposal ID.' });
    }
    const proposal = await Proposal.findById(req.params.id);
    if (!proposal) return res.status(404).json({ message: 'Proposal not found' });
    if (!['pending', 'shortlisted'].includes(proposal.status)) {
      return res.status(409).json({ message: 'Only pending or shortlisted proposals can be accepted.' });
    }

    const project = await Project.findOneAndUpdate(
      { _id: proposal.project, client: req.user._id, status: 'open' },
      { $set: { status: 'active' } },
      { new: true },
    );
    if (!project) {
      return res.status(409).json({ message: 'Project is no longer available for proposal acceptance.' });
    }

    proposal.status = 'accepted';
    await proposal.save();
    
    await Proposal.updateMany(
      { project: project._id, _id: { $ne: proposal._id }, status: 'pending' },
      { $set: { status: 'rejected' } }
    );
    
    res.json({ message: 'Proposal accepted', proposal });
  } catch (error) {
    sendError(res, error);
  }
});

router.put('/:id/reject', protect, authorize('client'), async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid proposal ID.' });
    }
    const proposal = await Proposal.findById(req.params.id);
    if (!proposal) return res.status(404).json({ message: 'Proposal not found' });
    
    const project = await Project.findById(proposal.project);
    if (!project) return res.status(404).json({ message: 'Project not found' });
    if (project.client.toString() !== req.user._id.toString()) return res.status(403).json({ message: 'Not authorized' });
    if (!['pending', 'shortlisted'].includes(proposal.status)) {
      return res.status(409).json({ message: 'Only pending or shortlisted proposals can be rejected.' });
    }

    const rejected = await Proposal.findOneAndUpdate(
      { _id: proposal._id, status: { $in: ['pending', 'shortlisted'] } },
      { $set: { status: 'rejected' } },
      { new: true },
    );
    if (!rejected) return res.status(409).json({ message: 'Proposal can no longer be rejected.' });
    res.json({ message: 'Proposal rejected', proposal: rejected });
  } catch (error) {
    sendError(res, error);
  }
});

router.put('/:id/withdraw', protect, authorize('freelancer'), async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid proposal ID.' });
    }
    const proposal = await Proposal.findById(req.params.id);
    if (!proposal) return res.status(404).json({ message: 'Proposal not found' });
    const project = await Project.findById(proposal.project);
    if (!project) return res.status(404).json({ message: 'Project not found' });
    if (proposal.freelancer.toString() !== req.user._id.toString()) return res.status(403).json({ message: 'Not authorized' });
    if (!['pending', 'shortlisted'].includes(proposal.status)) {
      return res.status(409).json({ message: 'Only pending or shortlisted proposals can be withdrawn.' });
    }

    const withdrawn = await Proposal.findOneAndUpdate(
      { _id: proposal._id, status: { $in: ['pending', 'shortlisted'] } },
      { $set: { status: 'withdrawn' } },
      { new: true },
    );
    if (!withdrawn) return res.status(409).json({ message: 'Proposal can no longer be withdrawn.' });
    await Project.updateOne({ _id: project._id }, { $inc: { proposalCount: -1 } });
    res.json({ message: 'Proposal withdrawn', proposal: withdrawn });
  } catch (error) {
    sendError(res, error);
  }
});

module.exports = router;
