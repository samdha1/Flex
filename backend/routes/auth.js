const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');
const OTP = require('../models/OTP');
const { protect } = require('../middleware/authMiddleware');

const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 10;

const createRateLimiter = () => {
  const requestsByIp = new Map();
  let lastCleanup = Date.now();

  return (req, res, next) => {
    const now = Date.now();
    if (now - lastCleanup >= RATE_LIMIT_WINDOW_MS) {
      for (const [ip, entry] of requestsByIp) {
        if (entry.resetAt <= now) requestsByIp.delete(ip);
      }
      lastCleanup = now;
    }

    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    let entry = requestsByIp.get(ip);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
      requestsByIp.set(ip, entry);
    }

    if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
      res.set('Retry-After', Math.ceil((entry.resetAt - now) / 1000).toString());
      return res.status(429).json({
        message: 'Too many requests. Please try again after 15 minutes.',
      });
    }

    entry.count += 1;
    next();
  };
};

const sendOtpRateLimiter = createRateLimiter();
const loginRateLimiter = createRateLimiter();

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
    const { email } = req.body;
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
    res.status(500).json({ message: error.message });
  }
});

router.post('/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;
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
    res.status(500).json({ message: error.message });
  }
});

router.post('/register', async (req, res) => {
  try {
    const { name, email, password, role, otpToken } = req.body;

    if (!otpToken) return res.status(400).json({ message: 'OTP verification required' });

    let otpClaims;
    try {
      otpClaims = jwt.verify(otpToken, process.env.JWT_SECRET);
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
    res.status(500).json({ message: error.message });
  }
});

router.post('/login', loginRateLimiter, async (req, res) => {
  try {
    const { email, password, otp } = req.body;
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
    res.status(500).json({ message: error.message });
  }
});

router.get('/me', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('-password');
    res.json({ user });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/update-profile', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);

    ['name', 'bio', 'location', 'phone', 'title', 'hourlyRate', 'availability', 'company', 'industry'].forEach(field => {
      if (req.body[field] !== undefined) user[field] = req.body[field];
    });

    if (req.body.skills) user.skills = req.body.skills;
    if (req.body.avatar) user.avatar = req.body.avatar;

    await user.save();

    res.json({ user });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/change-password', protect, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user._id);

    if (!(await user.matchPassword(currentPassword))) {
      return res.status(400).json({ message: 'Incorrect current password' });
    }

    user.password = newPassword;
    await user.save();

    res.json({ message: 'Password changed successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
