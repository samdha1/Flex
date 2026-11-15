const createRateLimiter = ({ windowMs, maxRequests, keyGenerator, message }) => {
  if (!Number.isSafeInteger(windowMs) || windowMs < 1) {
    throw new TypeError('Rate limiter windowMs must be a positive integer.');
  }
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1) {
    throw new TypeError('Rate limiter maxRequests must be a positive integer.');
  }

  const requestsByKey = new Map();
  let nextCleanup = Date.now() + windowMs;

  return (req, res, next) => {
    const now = Date.now();
    if (now >= nextCleanup) {
      for (const [key, entry] of requestsByKey) {
        if (entry.resetAt <= now) requestsByKey.delete(key);
      }
      nextCleanup = now + windowMs;
    }

    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    const key = keyGenerator ? keyGenerator(req, ip) : ip;
    let entry = requestsByKey.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      requestsByKey.set(key, entry);
    }

    if (entry.count >= maxRequests) {
      res.set('Retry-After', Math.ceil((entry.resetAt - now) / 1000).toString());
      return res.status(429).json({
        message: message || 'Too many requests. Please try again later.',
      });
    }

    entry.count += 1;
    return next();
  };
};

module.exports = { createRateLimiter };
