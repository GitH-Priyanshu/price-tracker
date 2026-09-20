import { Router } from 'express';
import { searchProducts, getCatalogStats } from '../services/storeClient.js';
import { createRateLimiter } from '../middleware/rateLimiter.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = Router();

// Rate limit: max 60 searches per minute per IP
const searchLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  message: 'Search rate limit exceeded. Please wait a moment before searching again.'
});

router.use(searchLimiter);

/**
 * GET /api/search/stats
 * Returns catalog cache statistics (size, page count, store total, has459, etc.)
 */
router.get('/stats', asyncHandler(async (req, res) => {
  const stats = getCatalogStats();
  return res.status(200).json(stats);
}));

/**
 * GET /api/search?q=
 * Searches the mock store catalog by keyword.
 * Requires query parameter 'q' of at least 2 characters.
 */
router.get('/', asyncHandler(async (req, res, next) => {
  try {
    const q = req.query.q;

    if (!q || typeof q !== 'string' || q.trim().length < 2) {
      return res.status(400).json({
        error: {
          code: 'INVALID_QUERY',
          message: 'Query parameter "q" is required and must be at least 2 characters long'
        }
      });
    }

    const products = await searchProducts(q.trim());
    const stats = getCatalogStats();

    return res.status(200).json({
      query: q.trim(),
      count: products.length,
      isPartial: Boolean(stats.isPartial),
      ...(stats.message ? { message: stats.message } : {}),
      products
    });
  } catch (err) {
    next(err);
  }
}));

export default router;
