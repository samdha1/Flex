const mongoose = require('mongoose');

const normalizeEmail = (value) => {
  if (typeof value !== 'string' || value.length > 254) return null;

  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
};

const isValidObjectId = (value) => (
  typeof value === 'string'
  && mongoose.Types.ObjectId.isValid(value)
  && String(new mongoose.Types.ObjectId(value)) === value
);

const escapeRegex = (value) => {
  if (typeof value !== 'string') throw new TypeError('Regex search value must be a string.');
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

const parsePagination = (query = {}, { maxLimit = 50 } = {}) => {
  const safeMaxLimit = Number.isSafeInteger(maxLimit) && maxLimit > 0 ? maxLimit : 50;
  const parseInteger = (value, fallback) => {
    if (typeof value !== 'string' && typeof value !== 'number') return fallback;
    if (typeof value === 'string' && !/^\d+$/.test(value)) return fallback;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : fallback;
  };

  const page = Math.max(1, parseInteger(query.page, 1));
  const limit = Math.min(safeMaxLimit, Math.max(1, parseInteger(query.limit, 10)));
  return { page, limit };
};

const sendError = (res, error) => {
  console.error('Request failed:', error);

  if (error && (error.name === 'ValidationError' || error.name === 'CastError')) {
    return res.status(400).json({ message: error.message });
  }
  if (error && error.code === 11000) {
    return res.status(409).json({ message: 'A record with this value already exists.' });
  }

  const message = process.env.NODE_ENV === 'production'
    ? 'Internal server error'
    : (error && error.message) || 'Something went wrong.';
  return res.status(500).json({ message });
};

module.exports = {
  normalizeEmail,
  isValidObjectId,
  escapeRegex,
  parsePagination,
  sendError,
};
