/**
 * Wraps an async route handler to ensure any unhandled rejection or synchronous error
 * is passed to next(err) and handled by Express's central error handler.
 * Prevents process crashes from unhandled errors in async routes.
 * 
 * @param {Function} fn - Async Express route handler (req, res, next) => Promise<any>
 * @returns {Function} Express middleware handler
 */
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

export default asyncHandler;
