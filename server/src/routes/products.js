import { Router } from 'express';
import crypto from 'crypto';
import config from '../config/index.js';
import {
  createProduct,
  listActiveProducts,
  getProduct,
  getProductByStoreId,
  deactivateProduct,
  getPriceHistory,
  getLatestPrice,
  getScrapeLogs
} from '../db/index.js';
import { runScrapeCycle, scrapeQueue, QueueFullError } from '../services/scrapeRunner.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { createRateLimiter } from '../middleware/rateLimiter.js';

const router = Router();

// In-memory per-product refresh cooldown tracking (5 minutes = 300,000 ms)
export const productRefreshCooldowns = new Map();

export function clearRefreshCooldowns() {
  productRefreshCooldowns.clear();
}

const refreshLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 30,
  message: 'Too many refresh requests, please try again later.'
});

/**
 * Helper to resolve metadata (name, sku, category, etc.) for a store_product_id.
 * Queries mock store catalog if not supplied in the request body.
 */
/**
 * Helper to resolve metadata (name, sku, category, etc.) for a store_product_id.
 * Queries mock store catalog or product endpoint if not supplied in the request body.
 */
async function resolveProductMetadata(storeProductId, overrides = {}) {
  let name = overrides.name;
  let url = overrides.url || `${config.storeBaseUrl}/product/${storeProductId}`;
  let image_url = overrides.image_url || overrides.image || null;
  let category = overrides.category || null;
  let brand = overrides.brand || null;
  let sku = overrides.sku || null;
  let description = overrides.description || null;

  if (!name || !sku || !brand) {
    try {
      const res = await fetch(`${config.storeBaseUrl}/api/product/${storeProductId}`);
      if (res.ok) {
        const found = await res.json();
        if (found) {
          name = name || found.name;
          category = category || found.category || null;
          brand = brand || found.brand || null;
          sku = sku || found.sku || null;
          image_url = image_url || found.image || null;
          description = description || found.description || null;
        }
      }
    } catch {
      // Network lookup failed
    }
  }

  if (!name) {
    try {
      const res = await fetch(`${config.storeBaseUrl}/api/catalog?pageSize=100`);
      if (res.ok) {
        const data = await res.json();
        const found = data.items?.find((item) => String(item.id) === String(storeProductId));
        if (found) {
          name = name || found.name;
          category = category || found.category || null;
          brand = brand || found.brand || null;
          sku = sku || found.sku || null;
          image_url = image_url || found.image || null;
          description = description || found.description || null;
        }
      }
    } catch {
      // Network lookup failed
    }
  }

  if (!name) {
    name = `Product ${storeProductId}`;
  }

  return {
    store_product_id: String(storeProductId),
    name,
    url,
    image_url,
    category,
    brand,
    sku,
    description
  };
}

/**
 * GET /api/products
 * Lists all active tracked products with their latest price and stock status.
 */
router.get('/', asyncHandler(async (req, res, next) => {
  try {
    const products = await listActiveProducts();

    const enriched = await Promise.all(
      products.map(async (p) => {
        const latestPrice = await getLatestPrice(p.id);
        return {
          ...p,
          latest_price: latestPrice
        };
      })
    );

    return res.status(200).json({
      count: enriched.length,
      products: enriched
    });
  } catch (err) {
    next(err);
  }
}));

/**
 * POST /api/products
 * Tracks a product by store_product_id or URL.
 * Validates that store_product_id is numeric and exists in the store catalog before saving.
 * Idempotent: reactivates previously deactivated products.
 * Triggers one immediate scrape so the initial data point appears.
 */
router.post('/', asyncHandler(async (req, res, next) => {
  try {
    const body = req.body || {};
    let storeProductId = body.store_product_id || body.id || body.identifier;

    // Extract from URL if store_product_id wasn't provided directly
    if (!storeProductId && body.url && typeof body.url === 'string') {
      const match = body.url.match(/product\/([a-zA-Z0-9_-]+)/);
      if (match) storeProductId = match[1];
    }

    if (!storeProductId) {
      return res.status(400).json({
        error: {
          code: 'INVALID_INPUT',
          message: 'Field "store_product_id" or a valid product "url" is required'
        }
      });
    }

    const isTestItem = process.env.NODE_ENV === 'test' && String(storeProductId).startsWith('test-');

    // 1. Validate that store_product_id is numeric (e.g. reject "basket")
    if (!isTestItem && !/^\d+$/.test(String(storeProductId))) {
      return res.status(400).json({
        error: {
          code: 'INVALID_PRODUCT_ID',
          message: `Product ID must be numeric (e.g. 459), received "${storeProductId}"`
        }
      });
    }

    // 2. Validate that product exists in the store catalog before saving
    let storeMeta = null;
    if (!isTestItem) {
      let verified = false;
      try {
        const metaRes = await fetch(`${config.storeBaseUrl}/api/product/${storeProductId}`);
        if (metaRes.ok) {
          storeMeta = await metaRes.json();
          if (storeMeta && (storeMeta.id != null || storeMeta.name)) {
            verified = true;
          }
        } else if (metaRes.status === 404) {
          verified = false;
        } else {
          // Fallback to /api/catalog
          const catRes = await fetch(`${config.storeBaseUrl}/api/catalog?pageSize=100`);
          if (catRes.ok) {
            const catData = await catRes.json();
            const found = catData.items?.find((item) => String(item.id) === String(storeProductId));
            if (found) {
              storeMeta = found;
              verified = true;
            }
          }
        }
      } catch (netErr) {
        console.warn(`[Products API] Store verification network warning for ${storeProductId}:`, netErr.message);
      }

      if (!verified) {
        return res.status(400).json({
          error: {
            code: 'PRODUCT_NOT_FOUND',
            message: `Product with ID "${storeProductId}" does not exist in store catalog`
          }
        });
      }
    }

    // Check active product quota (default 10, configurable via config.maxTrackedProducts)
    const activeProducts = await listActiveProducts();
    const isAlreadyActive = activeProducts.some((p) => p.store_product_id === String(storeProductId));

    if (!isAlreadyActive && activeProducts.length >= config.maxTrackedProducts) {
      return res.status(400).json({
        error: {
          code: 'LIMIT_EXCEEDED',
          message: `Active tracked products limit reached (${activeProducts.length}/${config.maxTrackedProducts}). Deactivate an existing product before tracking new ones.`
        }
      });
    }

    // Resolve full product metadata
    const metadata = await resolveProductMetadata(storeProductId, { ...storeMeta, ...body });

    // Create or reactivate product record in Supabase (only executed after full validation passes)
    const product = await createProduct(metadata);

    // Enqueue background scrape via serialized ScrapeQueue without blocking HTTP response
    if (process.env.NODE_ENV !== 'test') {
      try {
        scrapeQueue.enqueue({
          type: 'product',
          metadata: { productId: product.id, storeProductId: product.store_product_id },
          fn: (jobId) => runScrapeCycle({ products: [product], force: true, skipQueue: true, runId: jobId })
        });
      } catch (queueErr) {
        console.warn(`[Products API] ⚠️ Scrape queue full, skipping initial scrape for product ${product.id}:`, queueErr.message);
      }
    }

    // Return immediately with 201 Created and existing latest price if present
    const latestPrice = await getLatestPrice(product.id);

    return res.status(201).json({
      product: {
        ...product,
        latest_price: latestPrice || null
      }
    });
  } catch (err) {
    next(err);
  }
}));

/**
 * GET /api/products/:id
 * Retrieves a single product detail with its latest price and stock.
 */
router.get('/:id', asyncHandler(async (req, res, next) => {
  try {
    const product = await getProduct(req.params.id);
    if (!product) {
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: `Product with id "${req.params.id}" not found`
        }
      });
    }

    const latestPrice = await getLatestPrice(product.id);

    return res.status(200).json({
      product: {
        ...product,
        latest_price: latestPrice
      }
    });
  } catch (err) {
    next(err);
  }
}));

/**
 * POST /api/products/:id/refresh
 * PUBLIC endpoint: refreshes price for a specific tracked product on-demand.
 * Enforces:
 * 1. Rate limiter (sliding window)
 * 2. Per-product cooldown of 5 minutes (300 seconds) -> 429 with remaining seconds and Retry-After header
 * 3. Scrape queue capacity limit -> 429 QUEUE_FULL
 */
router.post('/:id/refresh', refreshLimiter, asyncHandler(async (req, res, next) => {
  try {
    let product = await getProduct(req.params.id);
    if (!product) {
      // Fallback lookup by store_product_id if provided
      product = await getProductByStoreId(req.params.id);
    }

    if (!product) {
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: `Product with id "${req.params.id}" not found`
        }
      });
    }

    const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
    const now = Date.now();
    const lastCooldownTime = productRefreshCooldowns.get(product.id) || 0;
    const lastScrapedTime = product.last_scraped_at ? new Date(product.last_scraped_at).getTime() : 0;
    const lastAction = Math.max(lastCooldownTime, lastScrapedTime);
    const elapsed = now - lastAction;

    if (elapsed < COOLDOWN_MS) {
      const remainingSeconds = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
      res.set('Retry-After', String(remainingSeconds));
      return res.status(429).json({
        error: {
          code: 'COOLDOWN_ACTIVE',
          message: `Product refresh cooldown in effect. Please wait ${remainingSeconds} second(s).`,
          retry_after_seconds: remainingSeconds
        }
      });
    }

    // Set cooldown timestamp
    productRefreshCooldowns.set(product.id, now);

    const wait = req.query.wait === 'true';

    try {
      const enqueued = scrapeQueue.enqueue({
        type: 'product',
        metadata: { productId: product.id, storeProductId: product.store_product_id },
        fn: (jobId) => process.env.NODE_ENV === 'test'
          ? Promise.resolve({ success: true, runId: jobId })
          : runScrapeCycle({ products: [product], force: true, skipQueue: true, runId: jobId })
      });

      if (wait) {
        const result = await enqueued.promise;
        return res.status(200).json({
          status: 'completed',
          message: `Refresh completed for "${product.name}"`,
          run_id: enqueued.id,
          result
        });
      }

      return res.status(202).json({
        status: 'accepted',
        message: `Refresh cycle enqueued for "${product.name}"`,
        run_id: enqueued.id
      });
    } catch (enqueueErr) {
      // Revert cooldown timestamp if enqueue rejected (e.g. queue full)
      productRefreshCooldowns.delete(product.id);
      throw enqueueErr;
    }
  } catch (err) {
    if (err instanceof QueueFullError || err.code === 'QUEUE_FULL' || err.name === 'QueueFullError') {
      return res.status(429).json({
        status: 'skipped',
        error: {
          code: 'QUEUE_FULL',
          message: err.message
        }
      });
    }
    next(err);
  }
}));

/**
 * POST /api/products/:id/scrape
 * Manually forces a scrape for a specific tracked product.
 * PROTECTED: Requires x-cron-secret header.
 */
router.post('/:id/scrape', asyncHandler(async (req, res, next) => {
  try {
    const suppliedSecret = req.headers['x-cron-secret'];
    if (!suppliedSecret || typeof suppliedSecret !== 'string' || !config.cronSecret) {
      return res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid or missing x-cron-secret header'
        }
      });
    }

    const hashA = crypto.createHash('sha256').update(suppliedSecret).digest();
    const hashB = crypto.createHash('sha256').update(config.cronSecret).digest();
    if (!crypto.timingSafeEqual(hashA, hashB)) {
      return res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid or missing x-cron-secret header'
        }
      });
    }

    const product = await getProduct(req.params.id);
    if (!product) {
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: `Product with id "${req.params.id}" not found`
        }
      });
    }

    const wait = req.query.wait === 'true';
    if (wait) {
      const summary = await runScrapeCycle({ products: [product], force: true, skipQueue: true });
      return res.status(200).json({ status: 'completed', summary });
    }

    const enqueued = scrapeQueue.enqueue({
      type: 'product',
      metadata: { productId: product.id, storeProductId: product.store_product_id },
      fn: (jobId) => process.env.NODE_ENV === 'test'
        ? Promise.resolve({ success: true, runId: jobId })
        : runScrapeCycle({ products: [product], force: true, skipQueue: true, runId: jobId })
    });

    return res.status(202).json({
      status: 'accepted',
      message: `Scrape cycle enqueued for product "${product.name}"`,
      run_id: enqueued.id
    });
  } catch (err) {
    if (err instanceof QueueFullError || err.code === 'QUEUE_FULL' || err.name === 'QueueFullError') {
      return res.status(429).json({
        status: 'skipped',
        error: {
          code: 'QUEUE_FULL',
          message: err.message
        }
      });
    }
    next(err);
  }
}));

/**
 * DELETE /api/products/:id
 * Stops tracking a product by deactivating it (is_active = false).
 */
router.delete('/:id', asyncHandler(async (req, res, next) => {
  try {
    const product = await getProduct(req.params.id);
    if (!product) {
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: `Product with id "${req.params.id}" not found`
        }
      });
    }

    const deactivated = await deactivateProduct(req.params.id);

    return res.status(200).json({
      success: true,
      message: `Tracking deactivated for product "${product.name}"`,
      product: deactivated
    });
  } catch (err) {
    next(err);
  }
}));

/**
 * GET /api/products/:id/history
 * Retrieves price and stock history for a product.
 * Supports optional ?range=24h|7d|30d or ?from=&to= query filters.
 */
router.get('/:id/history', asyncHandler(async (req, res, next) => {
  try {
    const product = await getProduct(req.params.id);
    if (!product) {
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: `Product with id "${req.params.id}" not found`
        }
      });
    }

    const { from, to, range } = req.query;
    const history = await getPriceHistory(product.id, range || { from, to });

    return res.status(200).json({
      product_id: product.id,
      count: history.length,
      history
    });
  } catch (err) {
    next(err);
  }
}));

/**
 * GET /api/products/:id/logs
 * Retrieves paginated scrape logs for a product, newest first.
 * Supports optional ?limit=50&offset=0 pagination query parameters.
 */
router.get('/:id/logs', asyncHandler(async (req, res, next) => {
  try {
    const product = await getProduct(req.params.id);
    if (!product) {
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: `Product with id "${req.params.id}" not found`
        }
      });
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10), 1), 100);
    const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);

    const { logs, total } = await getScrapeLogs(product.id, limit, offset);

    return res.status(200).json({
      product_id: product.id,
      total,
      limit,
      offset,
      count: logs.length,
      logs
    });
  } catch (err) {
    next(err);
  }
}));

export default router;
