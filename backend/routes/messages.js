const express = require('express');
const router = express.Router();
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const User = require('../models/User');
const { protect } = require('../middleware/authMiddleware');
const { isValidObjectId, sendError } = require('../utils/validate');

router.post('/conversations', protect, async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ message: 'A valid request body is required.' });
    }
    const { recipientId, projectId } = req.body;
    if (!isValidObjectId(recipientId)) {
      return res.status(400).json({ message: 'Invalid recipient ID.' });
    }
    if (projectId !== undefined && !isValidObjectId(projectId)) {
      return res.status(400).json({ message: 'Invalid project ID.' });
    }
    
    if (recipientId === req.user._id.toString()) {
      return res.status(400).json({ message: 'Cannot message yourself' });
    }
    if (!await User.exists({ _id: recipientId })) {
      return res.status(404).json({ message: 'Recipient not found.' });
    }
    
    let query = { participants: { $all: [req.user._id, recipientId] } };
    if (projectId) query.project = projectId;
    
    let conversation = await Conversation.findOne(query);
    
    if (!conversation) {
      conversation = await Conversation.create({
        participants: [req.user._id, recipientId],
        project: projectId || undefined
      });
    }
    
    res.json({ conversation });
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/conversations', protect, async (req, res) => {
  try {
    const conversations = await Conversation.find({ participants: req.user._id })
      .populate('participants', 'name avatar')
      .populate('project', 'title')
      .sort('-lastMessageAt');
      
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
    const conversation = await Conversation.findById(req.params.conversationId);
    if (!conversation || !conversation.participants.includes(req.user._id)) {
      return res.status(404).json({ message: 'Conversation not found' });
    }
    
    const messages = await Message.find({ conversation: req.params.conversationId })
      .populate('sender', 'name avatar')
      .sort('createdAt');
      
    res.json({ messages });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/:conversationId', protect, async (req, res) => {
  try {
    if (!isValidObjectId(req.params.conversationId)) {
      return res.status(400).json({ message: 'Invalid conversation ID.' });
    }
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ message: 'A valid request body is required.' });
    }
    const { content } = req.body;
    if (typeof content !== 'string' || !content.trim() || content.length > 5000) {
      return res.status(400).json({ message: 'Message content must be a non-empty string of at most 5000 characters.' });
    }
    const conversation = await Conversation.findById(req.params.conversationId);
    
    if (!conversation || !conversation.participants.includes(req.user._id)) {
      return res.status(404).json({ message: 'Conversation not found' });
    }
    
    const message = await Message.create({
      conversation: req.params.conversationId,
      sender: req.user._id,
      content: content.trim(),
      readBy: [req.user._id]
    });
    
    await Conversation.updateOne(
      { _id: conversation._id },
      { $set: { lastMessageAt: new Date() } },
    );
    
    await message.populate('sender', 'name avatar');
    
    // Emit via socket
    if (global.io) {
      global.io.to(req.params.conversationId).emit('receive_message', message);
    }
    
    res.status(201).json({ message });
  } catch (error) {
    sendError(res, error);
  }
});

module.exports = router;
