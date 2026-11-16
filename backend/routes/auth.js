const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const OTP = require('../models/OTP');
const { protect } = require('../middleware/authMiddleware');
const { normalizeEmail, sendError } = require('../utils/validate');
const { createRateLimiter } = require('../middleware/rateLimit');
const { safeCompareText, hashOtpCode, DUMMY_PASSWORD_HASH } = require('../utils/security');

const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;
const OTP_CODE_PATTERN = /^\d{6}$/;
const NAME_MAX_LENGTH = 80;
const PHONE_MAX_LENGTH = 32;
const SHORT_TEXT_MAX_LENGTH = 120;

const sendOtpRateLimiter = createRateLimiter({
  windowMs: RATE_LIMIT_WINDOW_MS,
  maxRequests: 10,
  message: 'Too many OTP requests. Please try again after 15 minutes.',
});
const verifyOtpRateLimiter = createRateLimiter({
  windowMs: RATE_LIMIT_WINDOW_MS,
  maxRequests: 30,
  keyGenerator: (req, ip) => {
    const email = normalizeEmail(req.body && req.body.email) || '';
    return `${ip}:${email}`;
  },
  message: 'Too many OTP verification attempts. Please try again after 15 minutes.',
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
const registerRateLimiter = createRateLimiter({
  windowMs: RATE_LIMIT_WINDOW_MS,
  maxRequests: 15,
  message: 'Too many registration attempts. Please try again after 15 minutes.',
});
const changePasswordRateLimiter = createRateLimiter({
  windowMs: RATE_LIMIT_WINDOW_MS,
  maxRequests: 10,
  keyGenerator: (req) => (req.user ? req.user._id.toString() : req.ip),
  message: 'Too many password change attempts. Please try again after 15 minutes.',
});

const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    algorithm: 'HS256',
  });
};

const issueOtp = async (email) => {
  const code = crypto.randomInt(100000, 1000000).toString();
  await OTP.deleteMany({ email });
  await OTP.create({ email, code: hashOtpCode(code) });
  return code;
};

const deliverOtpEmail = async (email, code, subject, intro) => {
  try {
    const sendEmail = require('../utils/sendEmail');
    await sendEmail({
      email,
      subject,
      message: `${intro} ${code}. It is valid for 10 minutes.`,
      html: `<p>${intro} <strong>${code}</strong>.</p><p>It is valid for 10 minutes.</p>`,
    });
    return true;
  } catch (error) {
    console.error('Email could not be sent (check Brevo API settings):', error.message);
    // The code was never delivered, so drop it instead of leaving a usable OTP behind.
    await OTP.deleteMany({ email });
    return false;
  }
};

const verifyOtp = async (email, otp) => {
  const record = await OTP.findOne({ email });
  if (!record) {
    return { valid: false, status: 400, message: 'Invalid or expired OTP' };
  }

  if (!safeCompareText(hashOtpCode(otp), record.code)) {
    const updatedRecord = await OTP.findByIdAndUpdate(
      record._id,
      { $inc: { attempts: 1 } },
      { new: true },
    );

    if (updatedRecord && updatedRecord.attempts >= MAX_OTP_ATTEMPTS) {
      await OTP.deleteOne({ _id: updatedRecord._id });
      return {
        valid: false,
        status: 429,
        message: 'Too many incorrect OTP attempts. Request a new code.',
      };
    }
    return { valid: false, status: 400, message: 'Invalid or expired OTP' };
  }

  const consumedRecord = await OTP.findOneAndDelete({ _id: record._id, code: record.code });
  if (!consumedRecord) {
    return { valid: false, status: 400, message: 'Invalid or expired OTP' };
  }
  return { valid: true };
};

router.post('/send-otp', sendOtpRateLimiter, async (req, res) => {
  try {
    const email = normalizeEmail(req.body && req.body.email);
    if (!email) return res.status(400).json({ message: 'A valid email address is required.' });

    const code = await issueOtp(email);
    const delivered = await deliverOtpEmail(email, code, 'Your Flex OTP Code', 'Your OTP code is');
    if (!delivered) {
      return res.status(500).json({ message: 'Failed to send OTP email. Please try again.' });
    }

    res.json({ message: 'OTP sent' });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/verify-otp', verifyOtpRateLimiter, async (req, res) => {
  try {
    const email = normalizeEmail(req.body && req.body.email);
    if (!email) return res.status(400).json({ message: 'A valid email address is required.' });
    const { otp } = req.body;
    if (typeof otp !== 'string' || !OTP_CODE_PATTERN.test(otp)) {
      return res.status(400).json({ message: 'OTP must be a 6-digit code.' });
    }

    const verification = await verifyOtp(email, otp);
    if (!verification.valid) {
      return res.status(verification.status).json({ message: verification.message });
    }

    // Short-lived proof of email ownership, required by /register.
    const otpToken = jwt.sign(
      { email, purpose: 'registration' },
      process.env.JWT_SECRET,
      { expiresIn: '10m', algorithm: 'HS256' },
    );

    res.json({ verified: true, otpToken });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/register', registerRateLimiter, async (req, res) => {
  try {
    const email = normalizeEmail(req.body && req.body.email);
    if (!email) return res.status(400).json({ message: 'A valid email address is required.' });
    const { name, password, role, otpToken } = req.body;

    if (typeof name !== 'string' || !name.trim() || name.trim().length > NAME_MAX_LENGTH) {
      return res.status(400).json({ message: `Name must be a non-empty string of at most ${NAME_MAX_LENGTH} characters.` });
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
      || otpClaims === null
      || otpClaims.purpose !== 'registration'
      || otpClaims.email !== email
    ) {
      return res.status(400).json({ message: 'OTP verification required' });
    }

    const userExists = await User.findOne({ email }).select('_id');
    if (userExists) return res.status(400).json({ message: 'User already exists' });

    const user = await User.create({ name: name.trim(), email, password, role });
    res.status(201).json({
      user: { _id: user._id, name: user.name, email: user.email, role: user.role, avatar: user.avatar, profileCompletion: user.profileCompletion },
      token: generateToken(user._id),
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
    if (otp !== undefined && (typeof otp !== 'string' || !OTP_CODE_PATTERN.test(otp))) {
      return res.status(400).json({ message: 'OTP must be a 6-digit code.' });
    }

    const user = await User.findOne({ email });
    // Always run one bcrypt comparison so a missing account and a wrong password
    // take the same amount of time and are indistinguishable to an attacker.
    const passwordMatches = await bcrypt.compare(password, user ? user.password : DUMMY_PASSWORD_HASH);

    if (!user || !passwordMatches) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    // Step 1: password is correct but no code supplied yet, so email one.
    if (!otp) {
      const code = await issueOtp(email);
      const delivered = await deliverOtpEmail(email, code, 'Your Flex Login OTP Code', 'Your login OTP code is');
      if (!delivered) {
        return res.status(500).json({ message: 'Failed to send OTP email.' });
      }
      return res.json({ otpRequired: true, message: 'OTP sent' });
    }

    // Step 2: password plus emailed code.
    const verification = await verifyOtp(email, otp);
    if (!verification.valid) {
      return res.status(verification.status).json({ message: verification.message });
    }

    res.json({
      user: { _id: user._id, name: user.name, email: user.email, role: user.role, avatar: user.avatar, profileCompletion: user.profileCompletion },
      token: generateToken(user._id),
    });
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

const AVAILABILITY_VALUES = ['available', 'busy', 'unavailable'];
const SKILL_LIMIT = 30;
const SKILL_MAX_LENGTH = 50;
const BIO_MAX_LENGTH = 1000;
const HOURLY_RATE_MAX = 1000000;

const isBlankOrShorterThan = (value, max) => (
  value === undefined || (typeof value === 'string' && value.length <= max)
);

router.put('/update-profile', protect, async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ message: 'A valid request body is required.' });
    }

    const updates = req.body;
    if (updates.name !== undefined && (
      typeof updates.name !== 'string' || !updates.name.trim() || updates.name.trim().length > NAME_MAX_LENGTH
    )) {
      return res.status(400).json({ message: `Name must be a non-empty string of at most ${NAME_MAX_LENGTH} characters.` });
    }
    if (!isBlankOrShorterThan(updates.bio, BIO_MAX_LENGTH)) {
      return res.status(400).json({ message: `Bio must be at most ${BIO_MAX_LENGTH} characters.` });
    }
    if (!isBlankOrShorterThan(updates.location, SHORT_TEXT_MAX_LENGTH)) {
      return res.status(400).json({ message: `Location must be at most ${SHORT_TEXT_MAX_LENGTH} characters.` });
    }
    if (!isBlankOrShorterThan(updates.phone, PHONE_MAX_LENGTH)) {
      return res.status(400).json({ message: `Phone must be at most ${PHONE_MAX_LENGTH} characters.` });
    }
    if (!isBlankOrShorterThan(updates.title, SHORT_TEXT_MAX_LENGTH)) {
      return res.status(400).json({ message: `Title must be at most ${SHORT_TEXT_MAX_LENGTH} characters.` });
    }
    if (!isBlankOrShorterThan(updates.company, SHORT_TEXT_MAX_LENGTH)) {
      return res.status(400).json({ message: `Company must be at most ${SHORT_TEXT_MAX_LENGTH} characters.` });
    }
    if (!isBlankOrShorterThan(updates.industry, SHORT_TEXT_MAX_LENGTH)) {
      return res.status(400).json({ message: `Industry must be at most ${SHORT_TEXT_MAX_LENGTH} characters.` });
    }
    if (updates.availability !== undefined && !AVAILABILITY_VALUES.includes(updates.availability)) {
      return res.status(400).json({ message: `Availability must be one of ${AVAILABILITY_VALUES.join(', ')}.` });
    }
    if (updates.avatar !== undefined && (
      typeof updates.avatar !== 'string'
      || updates.avatar.length > 500
      || (updates.avatar !== '' && !/^https?:\/\//i.test(updates.avatar))
    )) {
      return res.status(400).json({ message: 'Avatar must be an empty string or an HTTP(S) URL of at most 500 characters.' });
    }
    if (updates.skills !== undefined && (
      !Array.isArray(updates.skills)
      || updates.skills.length > SKILL_LIMIT
      || updates.skills.some((skill) => typeof skill !== 'string' || !skill.trim() || skill.length > SKILL_MAX_LENGTH)
    )) {
      return res.status(400).json({ message: `Skills must be an array of at most ${SKILL_LIMIT} non-empty strings, each at most ${SKILL_MAX_LENGTH} characters.` });
    }
    if (updates.hourlyRate !== undefined && updates.hourlyRate !== '') {
      const hourlyRate = Number(updates.hourlyRate);
      if (!Number.isFinite(hourlyRate) || hourlyRate < 0 || hourlyRate > HOURLY_RATE_MAX) {
        return res.status(400).json({ message: `Hourly rate must be a number between 0 and ${HOURLY_RATE_MAX}.` });
      }
    }

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    const textFields = ['name', 'bio', 'location', 'phone', 'title', 'availability', 'company', 'industry'];
    textFields.forEach((field) => {
      if (updates[field] === undefined) return;
      user[field] = typeof updates[field] === 'string' ? updates[field].trim() : updates[field];
    });

    if (updates.hourlyRate !== undefined) {
      user.hourlyRate = updates.hourlyRate === '' ? undefined : Number(updates.hourlyRate);
    }
    if (updates.skills !== undefined) {
      user.skills = updates.skills.map((skill) => skill.trim());
    }
    if (updates.avatar !== undefined) {
      user.avatar = updates.avatar;
    }

    await user.save();

    const safe = user.toObject();
    delete safe.password;
    res.json({ user: safe });
  } catch (error) {
    sendError(res, error);
  }
});

router.put('/change-password', protect, changePasswordRateLimiter, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      return res.status(400).json({ message: 'Passwords must be strings.' });
    }
    if (newPassword.length < 8 || newPassword.length > 72) {
      return res.status(400).json({ message: 'New password must be between 8 and 72 characters.' });
    }
    if (newPassword === currentPassword) {
      return res.status(400).json({ message: 'New password must be different from the current password.' });
    }

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    if (!(await user.matchPassword(currentPassword))) {
      return res.status(400).json({ message: 'Incorrect current password' });
    }

    user.password = newPassword;
    // The pre-save hook records passwordChangedAt, which revokes older tokens.
    await user.save();

    // Hand back a fresh token so this session stays signed in.
    res.json({ message: 'Password changed successfully', token: generateToken(user._id) });
  } catch (error) {
    sendError(res, error);
  }
});

module.exports = router;
