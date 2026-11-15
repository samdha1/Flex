const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Project = require('../models/Project');
const Proposal = require('../models/Proposal');
const { protect } = require('../middleware/authMiddleware');
const {
  escapeRegex,
  isValidObjectId,
  parsePagination,
  sendError,
} = require('../utils/validate');

router.get('/freelancers', async (req, res) => {
  try {
    const queryFields = ['search', 'skill', 'page', 'limit'];
    if (queryFields.some((field) => (
      req.query[field] !== undefined && typeof req.query[field] !== 'string'
    ))) {
      return res.status(400).json({ message: 'Query parameters must be strings.' });
    }
    const { search, skill } = req.query;
    if ((search && search.length > 100) || (skill && skill.length > 100)) {
      return res.status(400).json({ message: 'Search and skill values must be at most 100 characters.' });
    }
    const { page, limit } = parsePagination({
      ...req.query,
      limit: req.query.limit || '20',
    }, { maxLimit: 50 });
    if (
      (req.query.page !== undefined && !/^\d+$/.test(req.query.page))
      || (req.query.limit !== undefined && !/^\d+$/.test(req.query.limit))
    ) {
      return res.status(400).json({ message: 'Page and limit must be positive integers.' });
    }

    let query = { role: 'freelancer' };
    
    if (search) {
      query.$or = [
        { name: { $regex: escapeRegex(search), $options: 'i' } },
        { title: { $regex: escapeRegex(search), $options: 'i' } },
      ];
    }
    
    if (skill) {
      query.skills = { $regex: escapeRegex(skill), $options: 'i' };
    }
    
    const freelancers = await User.find(query)
      .select('-password -email -phone')
      .sort('-rating')
      .skip((page - 1) * limit)
      .limit(limit);
      
    res.json({ freelancers });
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/:id/profile', async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid user ID.' });
    }
    const user = await User.findById(req.params.id).select(
      'name role title bio location skills hourlyRate availability portfolio rating reviewCount completedProjects avatar company industry createdAt -_id',
    );
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({ user });
  } catch (error) {
    sendError(res, error);
  }
});

router.put('/portfolio/add', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    user.portfolio.push(req.body);
    await user.save();
    res.json({ portfolio: user.portfolio });
  } catch (error) {
    sendError(res, error);
  }
});

router.delete('/portfolio/:itemId', protect, async (req, res) => {
  try {
    if (!isValidObjectId(req.params.itemId)) {
      return res.status(400).json({ message: 'Invalid portfolio item ID.' });
    }
    const user = await User.findById(req.user._id);
    user.portfolio = user.portfolio.filter(item => item._id.toString() !== req.params.itemId);
    await user.save();
    res.json({ portfolio: user.portfolio });
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/dashboard/stats', protect, async (req, res) => {
  try {
    const userId = req.user._id;
    let stats = {};
    
    if (req.user.role === 'client') {
      stats.totalProjects = await Project.countDocuments({ client: userId });
      stats.activeProjects = await Project.countDocuments({ client: userId, status: 'active' });
      stats.completedProjects = await Project.countDocuments({ client: userId, status: 'completed' });
      const user = await User.findById(userId);
      stats.totalSpent = user.totalSpent || 0;
    } else {
      stats.totalProposals = await Proposal.countDocuments({ freelancer: userId });
      stats.activeProjects = await Proposal.countDocuments({ freelancer: userId, status: 'accepted' });
      const user = await User.findById(userId);
      stats.completedProjects = user.completedProjects || 0;
      stats.totalEarnings = user.totalEarnings || 0;
    }
    
    res.json({ stats });
  } catch (error) {
    sendError(res, error);
  }
});

module.exports = router;
