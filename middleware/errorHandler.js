/**
 * Beer POS - Error Handling Middleware
 * Unified error handling for all routes
 */

const logger = require('../src/utils/logger');

/**
 * Custom API Error class
 */
class ApiError extends Error {
  constructor(statusCode, message, errors = null) {
    super(message);
    this.statusCode = statusCode;
    this.errors = errors;
    this.name = 'ApiError';
  }

  static badRequest(message, errors = null) {
    return new ApiError(400, message, errors);
  }

  static unauthorized(message = 'Unauthorized') {
    return new ApiError(401, message);
  }

  static forbidden(message = 'Forbidden') {
    return new ApiError(403, message);
  }

  static notFound(message = 'Not found') {
    return new ApiError(404, message);
  }

  static internal(message = 'Internal server error') {
    return new ApiError(500, message);
  }

  static conflict(message, errors = null) {
    return new ApiError(409, message, errors);
  }
}

/**
 * Async handler wrapper - catches async errors and passes to error handler
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Global error handler middleware
 * Must be registered AFTER all routes
 */
function errorHandler(err, req, res, next) {
  // Log error
  logger.error('Request error', {
    method: req.method,
    path: req.path,
    error: err.message,
    stack: err.stack,
    ip: req.ip,
  });

  // Handle ApiError
  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({
      success: false,
      error: err.message,
      errors: err.errors
    });
  }

  // Handle validation errors
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      errors: err.errors || [{ message: err.message }]
    });
  }

  // Handle JSON parse errors
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({
      success: false,
      error: 'Invalid JSON in request body'
    });
  }

  // Handle SQLite errors
  if (err.code && err.code.startsWith('SQLITE_')) {
    logger.error('Database error', { code: err.code, message: err.message });
    return res.status(500).json({
      success: false,
      error: 'Database error occurred'
    });
  }

  // Default: Internal server error
  res.status(500).json({
    success: false,
    error: process.env.NODE_ENV === 'production' 
      ? 'Internal server error' 
      : err.message
  });
}

/**
 * Not found handler - for unmatched routes
 */
function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    error: `Route ${req.method} ${req.path} not found`
  });
}

/**
 * Request logger middleware
 */
function requestLogger(req, res, next) {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    if (req.path.startsWith('/api')) {
      logger.info('API Request', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration: `${duration}ms`,
      });
    }
  });

  next();
}

module.exports = {
  ApiError,
  asyncHandler,
  errorHandler,
  notFoundHandler,
  requestLogger
};
