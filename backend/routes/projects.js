const express = require('express');
const router = express.Router();
const Project = require('../models/Project');
const { protect, authorize } = require('../middleware/authMiddleware');
const {
  escapeRegex,
  isValidObjectId,
  parsePagination,
  sendError,
} = require('../utils/validate');

router.get('/', async (req, res) => {
  try {
    const queryFields = [
      'page', 'limit', 'search', 'skill', 'category', 'budgetType',
      'minBudget', 'maxBudget', 'experienceLevel', 'sort',
    ];
    if (queryFields.some((field) => (
      req.query[field] !== undefined && typeof req.query[field] !== 'string'
    ))) {
      return res.status(400).json({ message: 'Query parameters must be strings.' });
    }

    const {
      search, skill, category, budgetType, minBudget, maxBudget, experienceLevel, sort,
    } = req.query;
    if ((search && search.length > 100) || (skill && skill.length > 100)) {
      return res.status(400).json({ message: 'Search and skill values must be at most 100 characters.' });
    }
    const { page, limit } = parsePagination(req.query, { maxLimit: 50 });
    if (
      (req.query.page !== undefined && !/^\d+$/.test(req.query.page))
      || (req.query.limit !== undefined && !/^\d+$/.test(req.query.limit))
    ) {
      return res.status(400).json({ message: 'Page and limit must be positive integers.' });
    }
    for (const budget of [minBudget, maxBudget]) {
      if (budget !== undefined && (!Number.isFinite(Number(budget)) || Number(budget) < 0)) {
        return res.status(400).json({ message: 'Budget filters must be non-negative numbers.' });
      }
    }

    let query = { visibility: 'public', status: 'open' };
    
    if (search) query.title = { $regex: escapeRegex(search), $options: 'i' };
    if (skill) query.skills = { $regex: escapeRegex(skill), $options: 'i' };
    if (category) query.category = category;
    if (budgetType) query.budgetType = budgetType;
    if (minBudget) query.budgetMin = { $gte: Number(minBudget) };
    if (maxBudget) query.budgetMax = { $lte: Number(maxBudget) };
    if (experienceLevel) query.experienceLevel = experienceLevel;
    
    let sortObj = { createdAt: -1 };
    if (sort === 'budget_high') sortObj = { budgetMax: -1 };
    if (sort === 'budget_low') sortObj = { budgetMin: 1 };
    if (sort === 'most_proposals') sortObj = { proposalCount: -1 };
    
    const projects = await Project.find(query)
      .populate('client', 'name avatar rating')
      .sort(sortObj)
      .skip((page - 1) * limit)
      .limit(Number(limit));
      
    const total = await Project.countDocuments(query);
    
    res.json({
      projects,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/my', protect, async (req, res) => {
  try {
    if (
      (req.query.page !== undefined && typeof req.query.page !== 'string')
      || (req.query.limit !== undefined && typeof req.query.limit !== 'string')
      || (req.query.status !== undefined && typeof req.query.status !== 'string')
    ) {
      return res.status(400).json({ message: 'Query parameters must be strings.' });
    }
    const { page, limit } = parsePagination({
      ...req.query,
      limit: req.query.limit || '50',
    }, { maxLimit: 50 });
    if (
      (req.query.page !== undefined && !/^\d+$/.test(req.query.page))
      || (req.query.limit !== undefined && !/^\d+$/.test(req.query.limit))
    ) {
      return res.status(400).json({ message: 'Page and limit must be positive integers.' });
    }
    const { status } = req.query;
    let query = { client: req.user._id };
    if (status) query.status = status;
    
    const projects = await Project.find(query)
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(limit);
    res.json({ projects, page });
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/:id', async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid project ID.' });
    }
    const project = await Project.findById(req.params.id).populate('client', 'name company rating reviewCount avatar createdAt');
    if (!project) return res.status(404).json({ message: 'Project not found' });
    
    project.views += 1;
    await project.save();
    
    res.json({ project });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/', protect, authorize('client'), async (req, res) => {
  try {
    const project = await Project.create({
      ...req.body,
      client: req.user._id,
      status: req.body.saveAsDraft ? 'draft' : 'open'
    });
    res.status(201).json({ project });
  } catch (error) {
    sendError(res, error);
  }
});

module.exports = router;
