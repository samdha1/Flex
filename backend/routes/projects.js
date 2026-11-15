const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const Project = require('../models/Project');
const User = require('../models/User');
const { protect, authorize } = require('../middleware/authMiddleware');
const {
  escapeRegex,
  isValidObjectId,
  parsePagination,
  sendError,
} = require('../utils/validate');

const isProjectClient = async (req, project) => {
  const authorization = req.get('authorization') || '';
  const bearer = authorization.match(/^Bearer\s+(.+)$/i);
  if (!bearer) return false;

  let decoded;
  try {
    decoded = jwt.verify(bearer[1], process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return false;
  }

  if (
    typeof decoded !== 'object'
    || decoded === null
    || decoded.purpose !== undefined
    || !isValidObjectId(decoded.id)
    || decoded.id !== project.client?._id?.toString()
  ) {
    return false;
  }

  return Boolean(await User.exists({ _id: decoded.id }));
};

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

    if (
      ['draft', 'cancelled'].includes(project.status)
      || project.visibility === 'invite_only'
    ) {
      if (!await isProjectClient(req, project)) {
        return res.status(404).json({ message: 'Project not found' });
      }
    }
    
    await Project.updateOne({ _id: project._id }, { $inc: { views: 1 } });
    project.views = (project.views || 0) + 1;
    
    res.json({ project });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/', protect, authorize('client'), async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ message: 'A valid request body is required.' });
    }
    const body = req.body;
    if (
      typeof body.title !== 'string' || !body.title.trim()
      || typeof body.description !== 'string' || !body.description.trim()
      || typeof body.category !== 'string' || !body.category.trim()
    ) {
      return res.status(400).json({ message: 'Title, description, and category are required.' });
    }
    if (
      typeof body.budgetMin !== 'number' || !Number.isFinite(body.budgetMin) || body.budgetMin < 0
      || typeof body.budgetMax !== 'number' || !Number.isFinite(body.budgetMax) || body.budgetMax < 0
      || body.budgetMin > body.budgetMax
    ) {
      return res.status(400).json({ message: 'Budgets must be non-negative numbers and minimum must not exceed maximum.' });
    }
    if (
      (body.skills !== undefined && (!Array.isArray(body.skills) || body.skills.some(skill => typeof skill !== 'string')))
      || (body.tags !== undefined && (!Array.isArray(body.tags) || body.tags.some(tag => typeof tag !== 'string')))
    ) {
      return res.status(400).json({ message: 'Skills and tags must be arrays of strings.' });
    }
    if (
      body.saveAsDraft !== undefined && typeof body.saveAsDraft !== 'boolean'
    ) {
      return res.status(400).json({ message: 'saveAsDraft must be a boolean.' });
    }
    if (
      body.milestones !== undefined
      && (!Array.isArray(body.milestones) || body.milestones.some(milestone => (
        !milestone
        || typeof milestone !== 'object'
        || Array.isArray(milestone)
        || typeof milestone.title !== 'string'
        || !milestone.title.trim()
        || (milestone.description !== undefined && typeof milestone.description !== 'string')
        || typeof milestone.amount !== 'number'
        || !Number.isFinite(milestone.amount)
      )))
    ) {
      return res.status(400).json({ message: 'Milestones must include a title and numeric amount.' });
    }

    const projectData = {};
    const allowedFields = [
      'title', 'description', 'category', 'skills', 'tags', 'budgetType',
      'budgetMin', 'budgetMax', 'experienceLevel', 'projectLength',
      'deadline', 'visibility',
    ];
    for (const field of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(body, field) && !(field === 'deadline' && body[field] === '')) {
        projectData[field] = body[field];
      }
    }
    if (body.milestones !== undefined) {
      projectData.milestones = body.milestones.map(({ title, description, amount }) => ({
        title,
        description,
        amount,
      }));
    }

    const project = await Project.create({
      ...projectData,
      client: req.user._id,
      status: body.saveAsDraft ? 'draft' : 'open'
    });
    res.status(201).json({ project });
  } catch (error) {
    sendError(res, error);
  }
});

module.exports = router;
