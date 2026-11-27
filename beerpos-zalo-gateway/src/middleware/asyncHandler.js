/**
 * Wrapper cho async route handler.
 *
 * Express 4 KHONG bat loi tu async function (throw -> unhandled rejection ->
 * request treo). Wrapper nay day loi sang errorHandler.
 */
function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
