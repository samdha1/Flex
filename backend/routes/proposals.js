const express = require('express');
const router = express.Router();
const Proposal = require('../models/Proposal');
const Project = require('../models/Project');
const { protect, authorize } = require('../middleware/authMiddleware');
const { isValidObjectId, sendError } = require('../utils/validate');

const COVER_LETTER_MAX_LENGTH = 5000;
const BID_MAX = 100000000;
const DELIVERY_DAYS_MAX = 3650;

router.post('/', protect, authorize('freelancer'), async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ message: 'A valid request body is required.' });
    }
    const { projectId, coverLetter, bidAmount, deliveryTime } = req.body;
    if (!isValidObjectId(projectId)) {
      return res.status(400).json({ message: 'Invalid project ID.' });
    }
    if (typeof bidAmount !== 'number' || !Number.isFinite(bidAmount) || bidAmount <= 0 || bidAmount > BID_MAX) {
      return res.status(400).json({ message: `Bid amount must be a number between 0 and ${BID_MAX}.` });
    }
    if (!Number.isInteger(deliveryTime) || deliveryTime < 1 || deliveryTime > DELIVERY_DAYS_MAX) {
      return res.status(400).json({ message: `Delivery time must be an integer between 1 and ${DELIVERY_DAYS_MAX} days.` });
    }
    if (
      typeof coverLetter !== 'string'
      || !coverLetter.trim()
      || coverLetter.length > COVER_LETTER_MAX_LENGTH
    ) {
      return res.status(400).json({ message: `Cover letter must be a non-empty string of at most ${COVER_LETTER_MAX_LENGTH} characters.` });
    }
    
    const project = await Project.findById(projectId);
    if (!project) return res.status(404).json({ message: 'Project not found' });
    if (project.status !== 'open') return res.status(400).json({ message: 'Project is not open for proposals' });
    // Invite-only listings must not accept unsolicited proposals from anyone
    // who merely guessed the project ID.
    if (project.visibility !== 'public') {
      return res.status(403).json({ message: 'This project is invite only and is not accepting proposals.' });
    }
    
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

    const project = await Project.findById(proposal.project);
    if (!project) return res.status(404).json({ message: 'Project not found' });
    if (project.client.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    const previousStatus = proposal.status;
    const accepted = await Proposal.findOneAndUpdate(
      { _id: proposal._id, status: { $in: ['pending', 'shortlisted'] } },
      { status: 'accepted' },
      { new: true },
    );
    if (!accepted) return res.status(409).json({ message: 'Only pending or shortlisted proposals can be accepted.' });

    const activeProject = await Project.findOneAndUpdate(
      { _id: project._id, client: req.user._id, status: 'open' },
      { status: 'active' },
      { new: true },
    );
    if (!activeProject) {
      await Proposal.findOneAndUpdate(
        { _id: accepted._id, status: 'accepted' },
        { status: previousStatus },
      );
      return res.status(409).json({ message: 'Project is no longer available for proposal acceptance.' });
    }
    
    await Proposal.updateMany(
      { project: project._id, _id: { $ne: accepted._id }, status: { $in: ['pending', 'shortlisted'] } },
      { $set: { status: 'rejected' } }
    );
    
    res.json({ message: 'Proposal accepted', proposal: accepted });
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
    // Guard the decrement so the counter can never go negative.
    await Project.updateOne(
      { _id: project._id, proposalCount: { $gt: 0 } },
      { $inc: { proposalCount: -1 } },
    );
    res.json({ message: 'Proposal withdrawn', proposal: withdrawn });
  } catch (error) {
    sendError(res, error);
  }
});

module.exports = router;
