const rateLimit = require('express-rate-limit');
const { config } = require('../config');

/** Rate limit cho endpoint nhan tin tu BeerPOS. */
const sendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: config.rateLimit.send,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  keyGenerator: (req) => req.apiKeyFingerprint || `ip:${req.ip}`,
  message: {
    success: false,
    error: 'Quá nhiều yêu cầu gửi tin, vui lòng thử lại sau',
    code: 'RATE_LIMITED',
  },
});

/** Rate limit cho API quan tri. */
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: config.rateLimit.admin,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  keyGenerator: (req) => req.apiKeyFingerprint || `ip:${req.ip}`,
  message: {
    success: false,
    error: 'Quá nhiều yêu cầu, vui lòng thử lại sau',
    code: 'RATE_LIMITED',
  },
});

module.exports = { sendLimiter, adminLimiter };
