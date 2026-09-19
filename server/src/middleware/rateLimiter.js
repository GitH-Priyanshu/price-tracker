/**
 * In-memory sliding-window rate limiter middleware factory.
 * Zero external dependencies.
 * 
 * @param {Object} options
 * @param {number} [options.windowMs=60000] - Time window in milliseconds (default 1 min)
 * @param {number} [options.max=30] - Max allowed requests per IP in the window
 * @param {string} [options.message] - Custom error message
 * @returns {Function} Express middleware
 */
export function createRateLimiter(options = {}) {
  const windowMs = options.windowMs || 60 * 1000;
  const max = options.max || 30;
  const message = options.message || 'Too many requests, please try again later.';

  const ipMap = new Map();

  // Periodic cleanup of expired records every 5 minutes
  const interval = setInterval(() => {
    const now = Date.now();
    for (const [ip, timestamps] of ipMap.entries()) {
      const valid = timestamps.filter((t) => now - t < windowMs);
      if (valid.length === 0) {
        ipMap.delete(ip);
      } else {
        ipMap.set(ip, valid);
      }
    }
  }, 5 * 60 * 1000);
  interval.unref(); // Do not hold Node process open

  return (req, res, next) => {
    // Determine client IP
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() ||
               req.socket?.remoteAddress ||
               '127.0.0.1';

    const now = Date.now();
    const timestamps = (ipMap.get(ip) || []).filter((t) => now - t < windowMs);

    if (timestamps.length >= max) {
      return res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message
        }
      });
    }

    timestamps.push(now);
    ipMap.set(ip, timestamps);
    next();
  };
}
