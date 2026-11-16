const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Payment = require('../models/Payment');
const User = require('../models/User');
const { protect } = require('../middleware/authMiddleware');
const { isValidObjectId, parsePagination, sendError } = require('../utils/validate');
const { createRateLimiter } = require('../middleware/rateLimit');

const MIN_AMOUNT_PAISE = 100;
const MAX_AMOUNT_PAISE = 5000000;
const PLATFORM_FEE_RATE = 0.02;
const DESCRIPTION_MAX_LENGTH = 100;

const orderRateLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  maxRequests: 30,
  keyGenerator: (req) => (req.user ? req.user._id.toString() : req.ip),
  message: 'Too many payment orders created. Please try again later.',
});

const getRazorpay = () => {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    const error = new Error('Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.');
    error.status = 503;
    throw error;
  }
  const Razorpay = require('razorpay');
  return new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
};

const isValidPaiseAmount = (amount) => (
  Number.isInteger(amount) && amount >= MIN_AMOUNT_PAISE && amount <= MAX_AMOUNT_PAISE
);

const recordPayment = async ({ userId, orderId, paymentId, amountPaise, description }) => {
  const amount = amountPaise / 100;
  const platformFee = Math.round(amount * PLATFORM_FEE_RATE * 100) / 100;
  const netAmount = Math.round((amount - platformFee) * 100) / 100;

  let payment;
  try {
    payment = await Payment.create({
      client: userId,
      amount,
      platformFee,
      netAmount,
      type: 'escrow_fund',
      status: 'completed',
      razorpayOrderId: orderId,
      razorpayPaymentId: paymentId,
      description,
    });
  } catch (error) {
    // The unique index on razorpayPaymentId makes this idempotent: a retried
    // webhook or a second verify call cannot credit the same payment twice.
    if (error.code !== 11000) throw error;
    return Payment.findOne({ razorpayPaymentId: paymentId });
  }

  await User.updateOne({ _id: userId }, { $inc: { totalSpent: amount } });
  return payment;
};

router.get('/history', protect, async (req, res) => {
  try {
    if (
      (req.query.page !== undefined && typeof req.query.page !== 'string')
      || (req.query.limit !== undefined && typeof req.query.limit !== 'string')
    ) {
      return res.status(400).json({ message: 'Query parameters must be strings.' });
    }
    const { page, limit } = parsePagination({ ...req.query, limit: req.query.limit || '50' }, { maxLimit: 50 });

    const query = req.user.role === 'client'
      ? { client: req.user._id }
      : { freelancer: req.user._id };

    const transactions = await Payment.find(query)
      .populate('project', 'title')
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(limit);

    res.json({ transactions });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/razorpay/create-order', protect, orderRateLimiter, async (req, res) => {
  try {
    const { amount, currency = 'INR', description } = req.body || {};
    if (!isValidPaiseAmount(amount)) {
      return res.status(400).json({
        message: `Amount must be an integer between ${MIN_AMOUNT_PAISE} and ${MAX_AMOUNT_PAISE.toLocaleString()} paise.`,
      });
    }
    if (currency !== 'INR') {
      return res.status(400).json({ message: 'Currency must be INR.' });
    }
    if (description !== undefined && (
      typeof description !== 'string' || description.length > DESCRIPTION_MAX_LENGTH
    )) {
      return res.status(400).json({ message: `Description must be a string of at most ${DESCRIPTION_MAX_LENGTH} characters.` });
    }

    const instance = getRazorpay();
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
      keyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/razorpay/verify', protect, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (
      typeof razorpay_order_id !== 'string'
      || typeof razorpay_payment_id !== 'string'
      || typeof razorpay_signature !== 'string'
    ) {
      return res.status(400).json({ message: 'Razorpay order, payment, and signature values must be strings.' });
    }

    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    const expectedSignatureBuffer = Buffer.from(expectedSignature);
    const providedSignatureBuffer = Buffer.from(razorpay_signature);
    if (
      expectedSignatureBuffer.length !== providedSignatureBuffer.length
      || !crypto.timingSafeEqual(expectedSignatureBuffer, providedSignatureBuffer)
    ) {
      return res.status(400).json({ message: 'Payment verification failed (signature mismatch)' });
    }

    const instance = getRazorpay();
    const payment = await instance.payments.fetch(razorpay_payment_id);
    if (payment.order_id !== razorpay_order_id) {
      return res.status(400).json({ message: 'Payment does not belong to this order.' });
    }
    if (payment.status !== 'captured') {
      return res.status(409).json({ message: 'Payment not captured yet' });
    }

    const order = await instance.orders.fetch(razorpay_order_id);
    if (!order.notes || order.notes.userId !== req.user._id.toString()) {
      return res.status(403).json({ message: 'This payment order does not belong to the authenticated user.' });
    }
    if (
      order.currency !== 'INR'
      || !isValidPaiseAmount(order.amount)
      || !Number.isInteger(payment.amount)
      || payment.amount !== order.amount
    ) {
      return res.status(400).json({ message: 'Razorpay returned an invalid order amount or currency.' });
    }

    const recordedPayment = await recordPayment({
      userId: req.user._id,
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
      amountPaise: payment.amount,
      description: order.notes.description,
    });
    if (recordedPayment.client.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'This payment has already been recorded for another user.' });
    }
    res.json({ success: true, payment: recordedPayment });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/razorpay/webhook', async (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    return res.status(503).json({ message: 'Razorpay webhook is not configured.' });
  }

  const signature = req.get('X-Razorpay-Signature');
  if (typeof signature !== 'string' || !Buffer.isBuffer(req.body) || !/^[a-f\d]+$/i.test(signature)) {
    return res.status(400).json({ message: 'Invalid Razorpay webhook signature.' });
  }

  const expected = crypto.createHmac('sha256', secret).update(req.body).digest();
  const received = Buffer.from(signature, 'hex');
  if (received.length !== expected.length || !crypto.timingSafeEqual(expected, received)) {
    return res.status(400).json({ message: 'Invalid Razorpay webhook signature.' });
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch (error) {
    console.error('Could not parse Razorpay webhook payload:', error);
    return res.sendStatus(400);
  }

  if (!event || typeof event !== 'object' || event.event !== 'payment.captured') {
    return res.sendStatus(200);
  }

  const payment = event.payload && event.payload.payment && event.payload.payment.entity;
  if (!payment || typeof payment.order_id !== 'string' || typeof payment.id !== 'string') {
    console.error('Captured payment webhook is missing its order or payment ID.');
    return res.sendStatus(400);
  }

  try {
    const instance = getRazorpay();
    const order = await instance.orders.fetch(payment.order_id);
    if (!order.notes || !isValidObjectId(order.notes.userId)) {
      throw new Error(`Razorpay order ${payment.order_id} has no valid userId note.`);
    }
    // Confirms the captured amount matches the order we created.
    if (!Number.isInteger(payment.amount) || payment.amount !== order.amount) {
      throw new Error(`Razorpay payment ${payment.id} amount does not match order ${payment.order_id}.`);
    }
    if (!await User.exists({ _id: order.notes.userId })) {
      throw new Error(`Razorpay order ${payment.order_id} references a user that no longer exists.`);
    }

    await recordPayment({
      userId: order.notes.userId,
      orderId: payment.order_id,
      paymentId: payment.id,
      amountPaise: payment.amount,
      description: order.notes.description,
    });

    return res.sendStatus(200);
  } catch (error) {
    console.error('Could not record Razorpay captured payment webhook:', error);
    // A 5xx makes Razorpay retry, so a transient failure no longer loses the payment.
    return res.sendStatus(500);
  }
});

module.exports = router;
