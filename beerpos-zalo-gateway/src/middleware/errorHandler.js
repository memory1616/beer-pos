const logger = require('../logger');
const { AppError } = require('../utils/errors');

/**
 * Error handler — KHONG bao gio lo stack trace ra ngoài.
 */
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
    if (err instanceof AppError) {
      const body = {
        success: false,
        error: err.message,
        code: err.code,
      };
      if (err.errors) body.errors = err.errors;
      // Truong bo sung (vi du `accepted: false` cho loi chua lien ket nhom).
      if (err.extra && typeof err.extra === 'object') {
        Object.entries(err.extra).forEach(([k, v]) => {
          if (k !== 'status' && k !== 'code' && k !== 'expose' && k !== 'errors') {
            body[k] = v;
          }
        });
      }
      return res.status(err.status).json(body);
    }

  // Loi SQLite constraint -> thong bao ro rang, khong lo stack.
  const msg = String(err && err.message ? err.message : '');
  if (msg.includes('UNIQUE constraint failed')) {
    return res.status(409).json({
      success: false,
      error: 'Du lieu bi trung (Customer ID hoac Group ID da ton tai)',
      code: 'DUPLICATE',
    });
  }

  logger.error('[HTTP] Loi khong xu ly', {
    path: req.originalUrl,
    method: req.method,
    error: msg,
    stack: err && err.stack ? err.stack : undefined,
  });

  return res.status(500).json({
    success: false,
    error: 'Loi may chu, vui long thu lai',
    code: 'INTERNAL_ERROR',
  });
}

/** 404 handler. */
function notFoundHandler(req, res) {
  return res.status(404).json({
    success: false,
    error: 'Khong tim thay endpoint',
    code: 'NOT_FOUND',
  });
}

module.exports = { errorHandler, notFoundHandler };
