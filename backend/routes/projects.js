const express = require('express');
const router = express.Router();
const Project = require('../models/Project');
const Proposal = require('../models/Proposal');
const User = require('../models/User');
const { protect, authorize, verifyTokenClaims } = require('../middleware/authMiddleware');
const {
  escapeRegex,
  isValidObjectId,
  parsePagination,
  sendError,
} = require('../utils/validate');

const TITLE_MAX_LENGTH = 150;
const CATEGORY_MAX_LENGTH = 50;
const DESCRIPTION_MAX_LENGTH = 10000;
const SKILLS_LIMIT = 30;
const SKILL_MAX_LENGTH = 50;
const TAGS_LIMIT = 20;
const TAG_MAX_LENGTH = 50;
const MILESTONES_LIMIT = 20;
const MILESTONE_TITLE_MAX_LENGTH = 150;
const MILESTONE_DESCRIPTION_MAX_LENGTH = 2000;
const BUDGET_MAX = 100000000;
const PROJECT_STATUSES = ['draft', 'open', 'active', 'completed', 'cancelled'];

const isStringListWithin = (value, limit, maxLength) => (
  Array.isArray(value)
  && value.length <= limit
  && value.every((item) => typeof item === 'string' && item.length <= maxLength)
);

/**
 * Resolves the caller from the Authorization header when present.
 * Returns null for anonymous or invalid tokens so private projects stay hidden.
 */
const resolveViewerId = async (req) => {
  const authorization = req.get('authorization') || '';
  const bearer = authorization.match(/^Bearer\s+(.+)$/i);
  if (!bearer) return null;

  const { claims, error } = verifyTokenClaims(bearer[1]);
  if (error) return null;

  const user = await User.findById(claims.id).select('_id passwordChangedAt');
  if (!user || user.isTokenStale(claims.iat)) return null;
  return user._id.toString();
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

    const query = { visibility: 'public', status: 'open' };

    if (search) query.title = { $regex: escapeRegex(search), $options: 'i' };
    if (skill) query.skills = { $regex: escapeRegex(skill), $options: 'i' };
    if (category) query.category = category;
    if (budgetType) query.budgetType = budgetType;
    if (minBudget) query.budgetMin = { $gte: Number(minBudget) };
    if (maxBudget) query.budgetMax = { $lte: Number(maxBudget) };
    if (experienceLevel) query.experienceLevel = experienceLevel;

    // Whitelisted sort keys only, so the request cannot pick an unindexed field.
    const SORTS = {
      budget_high: { budgetMax: -1 },
      budget_low: { budgetMin: 1 },
      most_proposals: { proposalCount: -1 },
    };
    const sortObj = SORTS[sort] || { createdAt: -1 };

    const projects = await Project.find(query)
      .populate('client', 'name avatar rating')
      .sort(sortObj)
      .skip((page - 1) * limit)
      .limit(limit);

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
    if (status !== undefined && !PROJECT_STATUSES.includes(status)) {
      return res.status(400).json({ message: `Status must be one of ${PROJECT_STATUSES.join(', ')}.` });
    }

    let query;
    if (req.user.role === 'freelancer') {
      // Freelancers see the projects they were hired for.
      const accepted = await Proposal.find({ freelancer: req.user._id, status: 'accepted' })
        .select('project');
      query = { _id: { $in: accepted.map((proposal) => proposal.project) } };
    } else {
      query = { client: req.user._id };
    }
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
    const project = await Project.findById(req.params.id)
      .populate('client', 'name company rating reviewCount avatar createdAt');
    if (!project) return res.status(404).json({ message: 'Project not found' });

    const isPrivate = ['draft', 'cancelled'].includes(project.status)
      || project.visibility === 'invite_only';

    let viewerId = null;
    if (isPrivate) {
      viewerId = await resolveViewerId(req);
      const clientId = project.client && project.client._id
        ? project.client._id.toString()
        : project.client.toString();
      if (viewerId !== clientId) {
        return res.status(404).json({ message: 'Project not found' });
      }
    }

    // Only count views from people other than the owner.
    if (!viewerId) viewerId = await resolveViewerId(req);
    const clientId = project.client && project.client._id
      ? project.client._id.toString()
      : project.client.toString();
    if (viewerId !== clientId) {
      await Project.updateOne({ _id: project._id }, { $inc: { views: 1 } });
      project.views = (project.views || 0) + 1;
    }

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
      typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > TITLE_MAX_LENGTH
      || typeof body.description !== 'string' || !body.description.trim() || body.description.length > DESCRIPTION_MAX_LENGTH
      || typeof body.category !== 'string' || !body.category.trim() || body.category.length > CATEGORY_MAX_LENGTH
    ) {
      return res.status(400).json({
        message: `Title, description, and category are required. Title is limited to ${TITLE_MAX_LENGTH} characters, description to ${DESCRIPTION_MAX_LENGTH}, and category to ${CATEGORY_MAX_LENGTH}.`,
      });
    }
    if (
      typeof body.budgetMin !== 'number' || !Number.isFinite(body.budgetMin) || body.budgetMin < 0 || body.budgetMin > BUDGET_MAX
      || typeof body.budgetMax !== 'number' || !Number.isFinite(body.budgetMax) || body.budgetMax < 0 || body.budgetMax > BUDGET_MAX
      || body.budgetMin > body.budgetMax
    ) {
      return res.status(400).json({ message: `Budgets must be numbers between 0 and ${BUDGET_MAX}, and minimum must not exceed maximum.` });
    }
    if (body.skills !== undefined && !isStringListWithin(body.skills, SKILLS_LIMIT, SKILL_MAX_LENGTH)) {
      return res.status(400).json({ message: `Skills must be an array of at most ${SKILLS_LIMIT} strings, each at most ${SKILL_MAX_LENGTH} characters.` });
    }
    if (body.tags !== undefined && !isStringListWithin(body.tags, TAGS_LIMIT, TAG_MAX_LENGTH)) {
      return res.status(400).json({ message: `Tags must be an array of at most ${TAGS_LIMIT} strings, each at most ${TAG_MAX_LENGTH} characters.` });
    }
    if (body.saveAsDraft !== undefined && typeof body.saveAsDraft !== 'boolean') {
      return res.status(400).json({ message: 'saveAsDraft must be a boolean.' });
    }
    if (
      body.milestones !== undefined
      && (
        !Array.isArray(body.milestones)
        || body.milestones.length > MILESTONES_LIMIT
        || body.milestones.some((milestone) => (
          !milestone
          || typeof milestone !== 'object'
          || Array.isArray(milestone)
          || typeof milestone.title !== 'string'
          || !milestone.title.trim()
          || milestone.title.trim().length > MILESTONE_TITLE_MAX_LENGTH
          || (milestone.description !== undefined && (
            typeof milestone.description !== 'string'
            || milestone.description.length > MILESTONE_DESCRIPTION_MAX_LENGTH
          ))
          || typeof milestone.amount !== 'number'
          || !Number.isFinite(milestone.amount)
          || milestone.amount < 0
          || milestone.amount > BUDGET_MAX
        ))
      )
    ) {
      return res.status(400).json({
        message: `Milestones must be at most ${MILESTONES_LIMIT} entries, each with a title and a non-negative numeric amount.`,
      });
    }
    if (body.deadline !== undefined && body.deadline !== '') {
      const deadline = new Date(body.deadline);
      if (Number.isNaN(deadline.getTime())) {
        return res.status(400).json({ message: 'Deadline must be a valid date.' });
      }
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
    if (typeof projectData.title === 'string') projectData.title = projectData.title.trim();
    if (typeof projectData.category === 'string') projectData.category = projectData.category.trim();
    if (body.milestones !== undefined) {
      projectData.milestones = body.milestones.map(({ title, description, amount }) => ({
        title: title.trim(),
        description: typeof description === 'string' ? description.trim() : undefined,
        amount,
      }));
    }

    const project = await Project.create({
      ...projectData,
      client: req.user._id,
      status: body.saveAsDraft ? 'draft' : 'open',
    });
    res.status(201).json({ project });
  } catch (error) {
    sendError(res, error);
  }
});

module.exports = router;
