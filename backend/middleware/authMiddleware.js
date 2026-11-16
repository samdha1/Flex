const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { isValidObjectId } = require('../utils/validate');

const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;

const readBearerToken = (req) => {
  const authorization = req.get('authorization') || '';
  const match = authorization.match(BEARER_PATTERN);
  return match ? match[1] : null;
};

/**
 * Verifies a JWT and its claims shape.
 * Returns `{ claims }` on success or `{ error }` with a safe-to-log reason.
 */
const verifyTokenClaims = (token) => {
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch (error) {
    return { error: 'token failed' };
  }

  if (
    typeof decoded !== 'object'
    || decoded === null
    || decoded.purpose !== undefined
    || !isValidObjectId(decoded.id)
    || typeof decoded.iat !== 'number'
  ) {
    return { error: 'token failed' };
  }

  return { claims: decoded };
};

const protect = async (req, res, next) => {
  const token = readBearerToken(req);
  if (!token) {
    return res.status(401).json({ message: 'Not authorized, no token' });
  }

  const { claims, error } = verifyTokenClaims(token);
  if (error) {
    return res.status(401).json({ message: 'Not authorized, token failed' });
  }

  try {
    // passwordChangedAt is needed to reject tokens issued before a password change.
    const user = await User.findById(claims.id).select('-password');
    if (!user) return res.status(401).json({ message: 'Not authorized, user not found' });
    if (user.isTokenStale(claims.iat)) {
      return res.status(401).json({ message: 'Session expired, please sign in again' });
    }

    req.user = user;
    req.tokenIssuedAt = claims.iat;
    next();
  } catch (lookupError) {
    console.error('Token lookup failed:', lookupError);
    res.status(401).json({ message: 'Not authorized, token failed' });
  }
};

const authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: `Role ${req.user.role} is not authorized to access this route` });
    }
    next();
  };
};

module.exports = { protect, authorize, verifyTokenClaims };
