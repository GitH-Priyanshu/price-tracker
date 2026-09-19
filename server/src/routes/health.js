import { Router } from 'express';

const router = Router();

/**
 * GET /api/health
 * Liveness probe: returns 200 without requiring database connectivity.
 */
router.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

export default router;
