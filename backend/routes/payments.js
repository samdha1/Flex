const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Payment = require('../models/Payment');
const User = require('../models/User');
const { protect } = require('../middleware/authMiddleware');
const { sendError } = require('../utils/validate');

router.get('/history', protect, async (req, res) => {
  try {
    const query = req.user.role === 'client' ? { client: req.user._id } : { freelancer: req.user._id };
    const transactions = await Payment.find(query)
      .populate('project', 'title')
      .sort('-createdAt');
    res.json({ transactions });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/razorpay/create-order', protect, async (req, res) => {
  try {
    const { amount, currency = 'INR', description } = req.body;
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      return res.status(503).json({
        message: 'Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.',
      });
    }
    if (!Number.isInteger(amount) || amount < 100 || amount > 5000000) {
      return res.status(400).json({ message: 'Amount must be an integer between 100 and 5,000,000 paise.' });
    }
    if (currency !== 'INR') {
      return res.status(400).json({ message: 'Currency must be INR.' });
    }
    if (description !== undefined && (
      typeof description !== 'string' || description.length > 100
    )) {
      return res.status(400).json({ message: 'Description must be a string of at most 100 characters.' });
    }

    const Razorpay = require('razorpay');
    const instance = new Razorpay({ 
      key_id: process.env.RAZORPAY_KEY_ID, 
      key_secret: process.env.RAZORPAY_KEY_SECRET 
    });
    
    const order = await instance.orders.create({ 
      amount, 
      currency,
      notes: {
        userId: req.user._id.toString(),
        description: description && description.trim() ? description.trim() : 'FleX Payment',
      },
    });
    
    res.json({
      ...order,
      keyId: process.env.RAZORPAY_KEY_ID
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/razorpay/verify', protect, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (
      typeof razorpay_order_id !== 'string'
      || typeof razorpay_payment_id !== 'string'
      || typeof razorpay_signature !== 'string'
    ) {
      return res.status(400).json({ message: 'Razorpay order, payment, and signature values must be strings.' });
    }
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      return res.status(503).json({
        message: 'Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.',
      });
    }
    
    const hmac = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET);
    hmac.update(razorpay_order_id + "|" + razorpay_payment_id);
    const expectedSignature = hmac.digest('hex');
    
    const expectedSignatureBuffer = Buffer.from(expectedSignature);
    const providedSignatureBuffer = Buffer.from(
      typeof razorpay_signature === 'string' ? razorpay_signature : '',
    );
    if (
      expectedSignatureBuffer.length !== providedSignatureBuffer.length
      || !crypto.timingSafeEqual(expectedSignatureBuffer, providedSignatureBuffer)
    ) {
      return res.status(400).json({ message: 'Payment verification failed (signature mismatch)' });
    }

    const Razorpay = require('razorpay');
    const instance = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
    const order = await instance.orders.fetch(razorpay_order_id);
    if (!order.notes || order.notes.userId !== req.user._id.toString()) {
      return res.status(403).json({ message: 'This payment order does not belong to the authenticated user.' });
    }
    if (
      order.currency !== 'INR'
      || !Number.isInteger(order.amount)
      || order.amount < 100
      || order.amount > 5000000
    ) {
      return res.status(400).json({ message: 'Razorpay returned an invalid order amount or currency.' });
    }

    const existingPayment = await Payment.findOne({ razorpayPaymentId: razorpay_payment_id });
    if (existingPayment) {
      if (existingPayment.client.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: 'This payment has already been recorded for another user.' });
      }
      return res.json({ success: true, payment: existingPayment });
    }

    const amount = order.amount / 100;
    const platformFee = Math.round(amount * 0.02 * 100) / 100;
    const netAmount = Math.round((amount - platformFee) * 100) / 100;
    const payment = await Payment.create({
      client: req.user._id,
      amount,
      platformFee,
      netAmount,
      type: 'escrow_fund',
      status: 'completed',
      razorpayOrderId: razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id,
      description: order.notes.description,
    });
    
    await User.updateOne({ _id: req.user._id }, { $inc: { totalSpent: amount } });
    
    res.json({ success: true, payment });
  } catch (error) {
    sendError(res, error);
  }
});

module.exports = router;
