/**
 * Error nganh nghiem cho tang HTTP.
 * Moi loi luon co `code` de BeerPOS/UI phan biet va xu ly retry dung.
 */
class AppError extends Error {
  /**
   * @param {number} status - HTTP status
   * @param {string} code - ma loi machine-readable
   * @param {string} message - thong bao cho nguoi dung
   * @param {object} [extra]
   */
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.expose = true;
    this.extra = extra;
    Object.assign(this, extra);
  }
}

const badRequest = (message, code = 'VALIDATION_ERROR', extra) =>
  new AppError(400, code, message, extra);
const unauthorized = (message = 'Unauthorized', code = 'UNAUTHORIZED') =>
  new AppError(401, code, message);
const forbidden = (message = 'Forbidden', code = 'FORBIDDEN') =>
  new AppError(403, code, message);
const notFound = (message = 'Not found', code = 'NOT_FOUND', extra) =>
  new AppError(404, code, message, extra);
const conflict = (message, code = 'CONFLICT') => new AppError(409, code, message);
const tooMany = (message = 'Quá nhiều yêu cầu', code = 'RATE_LIMITED') =>
  new AppError(429, code, message);

module.exports = {
  AppError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  tooMany,
};
