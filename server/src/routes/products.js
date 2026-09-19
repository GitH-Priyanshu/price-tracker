import { Router } from 'express';
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
import { runScrapeCycle, scrapeQueue } from '../services/scrapeRunner.js';

const router = Router();

/**
 * Helper to resolve metadata (name, sku, category, etc.) for a store_product_id.
 * Queries mock store catalog if not supplied in the request body.
 */
async function resolveProductMetadata(storeProductId, overrides = {}) {
  let name = overrides.name;
  let url = overrides.url || `${config.storeBaseUrl}/product/${storeProductId}`;
  let image_url = overrides.image_url || null;
  let category = overrides.category || null;
  let brand = overrides.brand || null;
  let sku = overrides.sku || null;
  let description = overrides.description || null;

  if (!name) {
    try {
      // Fetch catalog page from mock store to find exact metadata
      const res = await fetch(`${config.storeBaseUrl}/api/catalog?pageSize=100`);
      if (res.ok) {
        const data = await res.json();
        const found = data.items?.find((item) => String(item.id) === String(storeProductId));
        if (found) {
          name = found.name;
          category = category || found.category || null;
          brand = brand || found.brand || null;
          sku = sku || found.sku || null;
          image_url = image_url || found.image || null;
          description = description || found.description || null;
        }
      }
    } catch {
      // Network lookup failed; use reasonable fallback
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
router.get('/', async (req, res, next) => {
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
});

/**
 * POST /api/products
 * Tracks a product by store_product_id or URL.
 * Idempotent: reactivates previously deactivated products.
 * Triggers one immediate scrape so the initial data point appears.
 */
router.post('/', async (req, res, next) => {
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

    // Check active product quota (default 10, configurable via config.maxTrackedProducts)
    const activeProducts = await listActiveProducts();
    const isAlreadyActive = activeProducts.some((p) => p.store_product_id === storeProductId);

    if (!isAlreadyActive && activeProducts.length >= config.maxTrackedProducts) {
      return res.status(400).json({
        error: {
          code: 'LIMIT_EXCEEDED',
          message: `Active tracked products limit reached (${activeProducts.length}/${config.maxTrackedProducts}). Deactivate an existing product before tracking new ones.`
        }
      });
    }

    // Resolve full product metadata
    const metadata = await resolveProductMetadata(storeProductId, body);

    // Create or reactivate product record in Supabase
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
});

/**
 * GET /api/products/:id
 * Retrieves a single product detail with its latest price and stock.
 */
router.get('/:id', async (req, res, next) => {
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
});

/**
 * DELETE /api/products/:id
 * Stops tracking a product by deactivating it (is_active = false).
 */
router.delete('/:id', async (req, res, next) => {
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
});

/**
 * GET /api/products/:id/history
 * Retrieves price and stock history for a product.
 * Supports optional ?range=24h|7d|30d or ?from=&to= query filters.
 */
router.get('/:id/history', async (req, res, next) => {
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
});

/**
 * GET /api/products/:id/logs
 * Retrieves paginated scrape logs for a product, newest first.
 * Supports optional ?limit=50&offset=0 pagination query parameters.
 */
router.get('/:id/logs', async (req, res, next) => {
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
});

export default router;
