const path = require('path');
const fs = require('fs');
const winston = require('winston');
const { config } = require('./config');

const logDir = path.join(__dirname, '..', 'logs');
try {
  fs.mkdirSync(logDir, { recursive: true });
} catch (_) {
  /* ignore */
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || (config.isTest ? 'error' : 'info'),
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'beerpos-zalo-gateway' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.timestamp({ format: 'HH:mm:ss' }),
        winston.format.printf(
          ({ level, message, timestamp, ...meta }) =>
            `${timestamp} [${level}] ${message} ` +
            (Object.keys(meta).length ? JSON.stringify(meta) : '')
        )
      ),
      silent: config.isTest && !process.env.GATEWAY_LOG_IN_TEST,
    }),
  ],
});

if (!config.isTest) {
  logger.add(
    new winston.transports.File({
      filename: path.join(logDir, 'gateway.log'),
      maxsize: 5 * 1024 * 1024,
      maxFiles: 3,
      tailable: true,
    })
  );
}

/** Che key/secret trong log. */
logger.redact = (obj) => {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [...obj] : { ...obj };
  ['apiKey', 'api_key', 'x-api-key', 'authorization', 'password', 'token'].forEach((k) => {
    if (k in out) out[k] = '***';
  });
  return out;
};

module.exports = logger;
