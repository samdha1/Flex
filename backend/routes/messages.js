const express = require('express');
const router = express.Router();
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const User = require('../models/User');
const Project = require('../models/Project');
const { protect } = require('../middleware/authMiddleware');
const { isValidObjectId, parsePagination, sendError } = require('../utils/validate');
const { createRateLimiter } = require('../middleware/rateLimit');

const MESSAGE_MAX_LENGTH = 5000;

const conversationCreateLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  maxRequests: 60,
  keyGenerator: (req) => (req.user ? req.user._id.toString() : req.ip),
  message: 'Too many conversations started. Please try again later.',
});

const messageSendLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 30,
  keyGenerator: (req) => (req.user ? req.user._id.toString() : req.ip),
  message: 'You are sending messages too quickly. Please slow down.',
});

// ObjectId values are separate instances, so reference equality never matches.
const isParticipant = (conversation, userId) => Boolean(
  conversation
  && Array.isArray(conversation.participants)
  && conversation.participants.some(
    (participant) => participant && participant.toString() === userId.toString(),
  ),
);

router.post('/conversations', protect, conversationCreateLimiter, async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ message: 'A valid request body is required.' });
    }
    const { recipientId, projectId } = req.body;
    if (!isValidObjectId(recipientId)) {
      return res.status(400).json({ message: 'Invalid recipient ID.' });
    }
    if (projectId !== undefined && projectId !== null && !isValidObjectId(projectId)) {
      return res.status(400).json({ message: 'Invalid project ID.' });
    }

    if (recipientId === req.user._id.toString()) {
      return res.status(400).json({ message: 'Cannot message yourself' });
    }
    if (!await User.exists({ _id: recipientId })) {
      return res.status(404).json({ message: 'Recipient not found.' });
    }
    if (projectId && !await Project.exists({ _id: projectId })) {
      return res.status(404).json({ message: 'Project not found.' });
    }

    const query = { participants: { $all: [req.user._id, recipientId] } };
    if (projectId) query.project = projectId;

    let conversation = await Conversation.findOne(query);

    if (!conversation) {
      conversation = await Conversation.create({
        participants: [req.user._id, recipientId],
        project: projectId || undefined,
      });
    }

    res.json({ conversation });
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/conversations', protect, async (req, res) => {
  try {
    if (
      (req.query.page !== undefined && typeof req.query.page !== 'string')
      || (req.query.limit !== undefined && typeof req.query.limit !== 'string')
    ) {
      return res.status(400).json({ message: 'Query parameters must be strings.' });
    }
    const { page, limit } = parsePagination({ ...req.query, limit: req.query.limit || '50' }, { maxLimit: 50 });

    const conversations = await Conversation.find({ participants: req.user._id })
      .populate('participants', 'name avatar')
      .populate('project', 'title')
      .sort('-lastMessageAt')
      .skip((page - 1) * limit)
      .limit(limit);

    res.json({ conversations });
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/:conversationId', protect, async (req, res) => {
  try {
    if (!isValidObjectId(req.params.conversationId)) {
      return res.status(400).json({ message: 'Invalid conversation ID.' });
    }
    const conversation = await Conversation.findById(req.params.conversationId).select('participants');
    if (!isParticipant(conversation, req.user._id)) {
      return res.status(404).json({ message: 'Conversation not found' });
    }

    const messages = await Message.find({ conversation: req.params.conversationId })
      .populate('sender', 'name avatar')
      .sort('createdAt');

    // Opening a conversation marks the other side's messages as read.
    await Message.updateMany(
      {
        conversation: req.params.conversationId,
        sender: { $ne: req.user._id },
        readBy: { $ne: req.user._id },
      },
      { $addToSet: { readBy: req.user._id } },
    );

    if (global.io) {
      global.io.to(req.params.conversationId).emit('messages_read', {
        conversationId: req.params.conversationId,
        readerId: req.user._id.toString(),
      });
    }

    res.json({ messages });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/:conversationId', protect, messageSendLimiter, async (req, res) => {
  try {
    if (!isValidObjectId(req.params.conversationId)) {
      return res.status(400).json({ message: 'Invalid conversation ID.' });
    }
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ message: 'A valid request body is required.' });
    }
    const { content } = req.body;
    if (typeof content !== 'string' || !content.trim() || content.length > MESSAGE_MAX_LENGTH) {
      return res.status(400).json({ message: `Message content must be a non-empty string of at most ${MESSAGE_MAX_LENGTH} characters.` });
    }

    const conversation = await Conversation.findById(req.params.conversationId).select('participants');
    if (!isParticipant(conversation, req.user._id)) {
      return res.status(404).json({ message: 'Conversation not found' });
    }

    const message = await Message.create({
      conversation: req.params.conversationId,
      sender: req.user._id,
      content: content.trim(),
      readBy: [req.user._id],
    });

    await Conversation.updateOne(
      { _id: conversation._id },
      { $set: { lastMessageAt: new Date() } },
    );

    await message.populate('sender', 'name avatar');

    if (global.io) {
      global.io.to(req.params.conversationId).emit('receive_message', message);
    }

    res.status(201).json({ message });
  } catch (error) {
    sendError(res, error);
  }
});

module.exports = router;
