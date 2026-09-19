import { Router } from 'express';
import crypto from 'crypto';
import config from '../config/index.js';
import { runScrapeCycle } from '../services/scrapeRunner.js';
import { createRateLimiter } from '../middleware/rateLimiter.js';

const router = Router();

// Rate limit: max 20 cron trigger attempts per minute per IP
const cronLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 20,
  message: 'Cron rate limit exceeded.'
});

router.use(cronLimiter);

/**
 * Constant-time comparison between supplied header and configured CRON_SECRET.
 * Uses SHA-256 digest comparison to avoid length-leaking timing discrepancies.
 * @param {string} supplied
 * @param {string} configured
 * @returns {boolean}
 */
function constantTimeSecretCompare(supplied, configured) {
  if (!supplied || !configured || typeof supplied !== 'string' || typeof configured !== 'string') {
    return false;
  }
  const hashA = crypto.createHash('sha256').update(supplied).digest();
  const hashB = crypto.createHash('sha256').update(configured).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

/**
 * POST /api/cron/scrape
 * Scheduled scrape trigger endpoint.
 * Protected by x-cron-secret header.
 * 
 * In normal mode: responds immediately with HTTP 202 and run_id to prevent
 * external cron timeouts (cron-job.org), executing scrape in background.
 * In manual/test mode (?wait=true): awaits cycle completion and returns full summary.
 */
router.post('/scrape', async (req, res, next) => {
  try {
    const suppliedSecret = req.headers['x-cron-secret'];

    // 1. Verify authentication using constant-time check
    if (!constantTimeSecretCompare(suppliedSecret, config.cronSecret)) {
      return res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid or missing x-cron-secret header'
        }
      });
    }

    const wait = req.query.wait === 'true';
    const force = req.query.force === 'true';

    // 2. If wait=true (manual test / verification mode)
    if (wait) {
      const summary = await runScrapeCycle({ force });
      return res.status(200).json({
        status: 'completed',
        summary
      });
    }

    // 3. Normal async mode: respond immediately with 202 Accepted
    const runId = crypto.randomUUID();

    // In test environment, skip background scrape to guarantee zero live DB mutations
    if (process.env.NODE_ENV !== 'test') {
      // Launch scrape cycle in background without blocking response
      setImmediate(() => {
        runScrapeCycle({ force }).catch((err) => {
          console.error(`[Cron Background Error] Scrape cycle ${runId} failed:`, err.message);
        });
      });
    }

    return res.status(202).json({
      status: 'accepted',
      message: 'Scrape cycle accepted and running in background',
      run_id: runId
    });
  } catch (err) {
    next(err);
  }
});

export default router;
