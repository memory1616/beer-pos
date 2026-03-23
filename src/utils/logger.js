/**
 * Beer POS - Winston Logger
 * Structured logging with levels, rotation, and timestamps
 */
const winston = require('winston');
const path = require('path');
const fs = require('fs');

const logDir = path.join(__dirname, '..', 'logs');

// Ensure logs directory exists
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const { combine, timestamp, printf, colorize, errors } = winston.format;

// Custom format for development readability
const devFormat = printf(({ level, message, timestamp, stack, ...meta }) => {
  const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : '';
  const stackStr = stack ? '\n' + stack : '';
  return `${timestamp} [${level}]: ${message}${metaStr}${stackStr}`;
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    devFormat
  ),
  transports: [
    // Always write errors to error.log
    new winston.transports.File({
      filename: path.join(logDir, 'error.log'),
      level: 'error',
      maxsize: 5 * 1024 * 1024,   // 5 MB
      maxFiles: 3,
    }),
    // All logs to combined.log
    new winston.transports.File({
      filename: path.join(logDir, 'combined.log'),
      maxsize: 5 * 1024 * 1024,   // 5 MB
      maxFiles: 3,
    }),
  ],
});

// In development, also log to console with colors (disabled to reduce CPU)
if (process.env.NODE_ENV === 'production') {
  logger.add(new winston.transports.Console({
    format: combine(
      colorize(),
      timestamp({ format: 'HH:mm:ss' }),
      devFormat
    ),
  }));
}

module.exports = logger;
