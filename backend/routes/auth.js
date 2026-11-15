const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');
const OTP = require('../models/OTP');
const { protect } = require('../middleware/authMiddleware');
const { normalizeEmail, sendError } = require('../utils/validate');
const { createRateLimiter } = require('../middleware/rateLimit');

const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const sendOtpRateLimiter = createRateLimiter({
  windowMs: RATE_LIMIT_WINDOW_MS,
  maxRequests: 10,
  message: 'Too many OTP requests. Please try again after 15 minutes.',
});
const loginRateLimiter = createRateLimiter({
  windowMs: RATE_LIMIT_WINDOW_MS,
  maxRequests: 20,
  keyGenerator: (req, ip) => {
    const email = req.body && typeof req.body.email === 'string'
      ? req.body.email.trim().toLowerCase()
      : '';
    return `${ip}:${email}`;
  },
  message: 'Too many login attempts for this email and IP. Please try again after 15 minutes.',
});

const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
};

const verifyOtp = async (email, otp) => {
  const record = await OTP.findOne({ email });
  if (!record) {
    return { valid: false, status: 400, message: 'Invalid or expired OTP' };
  }

  if (record.code !== String(otp)) {
    const updatedRecord = await OTP.findByIdAndUpdate(
      record._id,
      { $inc: { attempts: 1 } },
      { new: true },
    );

    if (updatedRecord && updatedRecord.attempts >= 5) {
      await OTP.deleteOne({ _id: updatedRecord._id });
      return {
        valid: false,
        status: 429,
        message: 'Too many incorrect OTP attempts. Request a new code.',
      };
    }
    return { valid: false, status: 400, message: 'Invalid or expired OTP' };
  }

  const consumedRecord = await OTP.findOneAndDelete({ _id: record._id, code: String(otp) });
  if (!consumedRecord) {
    return { valid: false, status: 400, message: 'Invalid or expired OTP' };
  }
  return { valid: true };
};

router.post('/send-otp', sendOtpRateLimiter, async (req, res) => {
  try {
    const email = normalizeEmail(req.body && req.body.email);
    if (!email) return res.status(400).json({ message: 'A valid email address is required.' });
    const code = crypto.randomInt(100000, 1000000).toString();

    await OTP.deleteMany({ email });
    await OTP.create({ email, code });

    // Try to send email, but don't fail if it doesn't work in dev mode
    let emailSent = false;
    try {
      const sendEmail = require('../utils/sendEmail');
      await sendEmail({
        email: email,
        subject: 'Your Flex OTP Code',
        message: `Your OTP code is ${code}. It is valid for 10 minutes.`,
        html: `<p>Your OTP code is <strong>${code}</strong>.</p><p>It is valid for 10 minutes.</p>`
      });
      emailSent = true;
    } catch (err) {
      console.error('Email could not be sent (check Brevo API settings):', err.message);
    }

    if (!emailSent) {
      return res.status(500).json({ message: 'Failed to send OTP email. Please try again.' });
    }

    res.json({ message: 'OTP sent' });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/verify-otp', async (req, res) => {
  try {
    const email = normalizeEmail(req.body && req.body.email);
    if (!email) return res.status(400).json({ message: 'A valid email address is required.' });
    const { otp } = req.body;
    if (typeof otp !== 'string') {
      return res.status(400).json({ message: 'OTP must be a string.' });
    }

    const verification = await verifyOtp(email, otp);
    if (!verification.valid) {
      return res.status(verification.status).json({ message: verification.message });
    }

    // Create a temporary verification token to allow registration
    const otpToken = jwt.sign(
      { email, purpose: 'registration' },
      process.env.JWT_SECRET,
      { expiresIn: '10m' },
    );

    res.json({ verified: true, otpToken });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/register', async (req, res) => {
  try {
    const email = normalizeEmail(req.body && req.body.email);
    if (!email) return res.status(400).json({ message: 'A valid email address is required.' });
    const { name, password, role, otpToken } = req.body;

    if (typeof name !== 'string') {
      return res.status(400).json({ message: 'Name must be a string.' });
    }
    if (typeof password !== 'string' || password.length < 8 || password.length > 72) {
      return res.status(400).json({ message: 'Password must be a string between 8 and 72 characters.' });
    }
    if (role !== 'client' && role !== 'freelancer') {
      return res.status(400).json({ message: 'Role must be client or freelancer.' });
    }
    if (typeof otpToken !== 'string') {
      return res.status(400).json({ message: 'OTP verification required' });
    }

    let otpClaims;
    try {
      otpClaims = jwt.verify(otpToken, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    } catch (error) {
      return res.status(400).json({ message: 'OTP verification required' });
    }
    if (
      typeof otpClaims !== 'object'
      || otpClaims.purpose !== 'registration'
      || otpClaims.email !== email
    ) {
      return res.status(400).json({ message: 'OTP verification required' });
    }

    const userExists = await User.findOne({ email });
    if (userExists) return res.status(400).json({ message: 'User already exists' });

    const user = await User.create({ name, email, password, role });
    res.status(201).json({
      user: { _id: user._id, name: user.name, email: user.email, role: user.role, avatar: user.avatar, profileCompletion: user.profileCompletion },
      token: generateToken(user._id)
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/login', loginRateLimiter, async (req, res) => {
  try {
    const email = normalizeEmail(req.body && req.body.email);
    if (!email) return res.status(400).json({ message: 'A valid email address is required.' });
    const { password, otp } = req.body;
    if (typeof password !== 'string' || password.length < 8 || password.length > 72) {
      return res.status(400).json({ message: 'Password must be a string between 8 and 72 characters.' });
    }
    if (otp !== undefined && typeof otp !== 'string') {
      return res.status(400).json({ message: 'OTP must be a string.' });
    }
    const user = await User.findOne({ email });

    if (user && (await user.matchPassword(password))) {
      // If no OTP in request, generate one and ask for it
      if (!otp) {
        const code = crypto.randomInt(100000, 1000000).toString();
        await OTP.deleteMany({ email });
        await OTP.create({ email, code });

        let emailSent = false;
        try {
          const sendEmail = require('../utils/sendEmail');
          await sendEmail({
            email: email,
            subject: 'Your Flex Login OTP Code',
            message: `Your login OTP code is ${code}. It is valid for 10 minutes.`,
            html: `<p>Your login OTP code is <strong>${code}</strong>.</p><p>It is valid for 10 minutes.</p>`
          });
          emailSent = true;
        } catch (err) {
          console.error('Email could not be sent (check Brevo API settings):', err.message);
        }

        if (!emailSent) {
          return res.status(500).json({ message: 'Failed to send OTP email.' });
        }

        return res.json({ otpRequired: true, message: 'OTP sent' });
      }

      // If OTP provided, verify it
      const verification = await verifyOtp(email, otp);
      if (!verification.valid) {
        return res.status(verification.status).json({ message: verification.message });
      }

      // OTP valid, successful login
      res.json({
        user: { _id: user._id, name: user.name, email: user.email, role: user.role, avatar: user.avatar, profileCompletion: user.profileCompletion },
        token: generateToken(user._id)
      });
    } else {
      res.status(401).json({ message: 'Invalid email or password' });
    }
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/me', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('-password');
    res.json({ user });
  } catch (error) {
    sendError(res, error);
  }
});

router.put('/update-profile', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (req.body.name !== undefined && typeof req.body.name !== 'string') {
      return res.status(400).json({ message: 'Name must be a string.' });
    }

    ['name', 'bio', 'location', 'phone', 'title', 'hourlyRate', 'availability', 'company', 'industry'].forEach(field => {
      if (req.body[field] !== undefined) user[field] = req.body[field];
    });

    if (req.body.skills) user.skills = req.body.skills;
    if (req.body.avatar) user.avatar = req.body.avatar;

    await user.save();

    res.json({ user });
  } catch (error) {
    sendError(res, error);
  }
});

router.put('/change-password', protect, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      return res.status(400).json({ message: 'Passwords must be strings.' });
    }
    if (newPassword.length < 8 || newPassword.length > 72) {
      return res.status(400).json({ message: 'New password must be between 8 and 72 characters.' });
    }
    const user = await User.findById(req.user._id);

    if (!(await user.matchPassword(currentPassword))) {
      return res.status(400).json({ message: 'Incorrect current password' });
    }

    user.password = newPassword;
    await user.save();

    res.json({ message: 'Password changed successfully' });
  } catch (error) {
    sendError(res, error);
  }
});

module.exports = router;
