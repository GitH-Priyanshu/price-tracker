import { randomUUID } from 'crypto';
import config from '../config/index.js';
import {
  listActiveProducts,
  getProduct,
  insertPriceHistory,
  insertScrapeLog,
  updateProductScrapeStatus,
  getMostRecentLogStart
} from '../db/index.js';
import { scrapeProduct } from './storeClient.js';

// Export unforgeable internal Symbol token for test runner invocation
export const RUNNER_TEST_TOKEN = Symbol('RUNNER_TEST_TOKEN');

// In-memory cycle lock
let isCycleRunning = false;
let activeRunId = null;

/**
 * Runs a list of async tasks with limited concurrency.
 * @template T, R
 * @param {Array<T>} items
 * @param {number} concurrency
 * @param {(item: T) => Promise<R>} fn
 * @returns {Promise<Array<R>>}
 */
async function mapConcurrent(items, concurrency, fn) {
  const results = [];
  const executing = new Set();

  for (const item of items) {
    const p = Promise.resolve().then(() => fn(item));
    results.push(p);
    executing.add(p);

    const clean = () => executing.delete(p);
    p.then(clean, clean);

    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
}

/**
 * Scrapes a single product, validates results, writes to Supabase, and updates status.
 * Guarantees that a scrape_log is ALWAYS recorded and bad data is NEVER written to price_history.
 * 
 * @param {Object} product
 * @param {string} runId
 * @param {Object} options
 * @returns {Promise<{ productId: string, status: 'success'|'retried'|'failed'|'skipped', reason?: string }>}
 */
async function processProductScrape(product, runId, options = {}) {
  const { force = false, scraperFn = scrapeProduct } = options;
  const startedAt = new Date().toISOString();
  const startTime = Date.now();

  // 1. Duplicate-trigger guard
  if (!force) {
    try {
      const lastStart = await getMostRecentLogStart(product.id);
      if (lastStart) {
        const elapsedMinutes = (Date.now() - lastStart.getTime()) / (1000 * 60);
        if (elapsedMinutes < config.dedupeWindowMinutes) {
          console.log(
            `[ScrapeRunner] Skipping product "${product.name}" (${product.store_product_id}): ` +
            `scraped ${elapsedMinutes.toFixed(1)}m ago (< ${config.dedupeWindowMinutes}m window)`
          );
          return {
            productId: product.id,
            storeProductId: product.store_product_id,
            name: product.name,
            status: 'skipped',
            reason: `Scraped within dedupe window (${elapsedMinutes.toFixed(1)}m < ${config.dedupeWindowMinutes}m)`
          };
        }
      }
    } catch (e) {
      console.warn(`[ScrapeRunner] Dedupe check failed for product ${product.id}, proceeding:`, e.message);
    }
  }

  console.log(`[ScrapeRunner] Scraping "${product.name}" (store_id: ${product.store_product_id})...`);

  let scrapeResult = null;

  try {
    // 2. Execute fetch-parse-validate pipeline
    scrapeResult = await scraperFn(product, { headed: options.headed });
  } catch (err) {
    // Unexpected exception in scraper code itself
    console.error(`[ScrapeRunner] Unexpected scraper exception for product ${product.id}:`, err);
    scrapeResult = {
      success: false,
      attempts: 1,
      error_type: 'PARSE_ERROR',
      error_message: err.message,
      http_status: null,
      attempt_details: [
        {
          attempt: 1,
          at: new Date().toISOString(),
          outcome: 'failed',
          error_type: 'PARSE_ERROR',
          error_message: err.message,
          duration_ms: Date.now() - startTime
        }
      ]
    };
  }

  const finishedAt = new Date().toISOString();
  const durationMs = Date.now() - startTime;

  // 3. Handle Validated Success
  if (scrapeResult.success && scrapeResult.data) {
    let priceHistoryRow = null;
    try {
      // Write ONLY to price_history on validated success
      priceHistoryRow = await insertPriceHistory({
        product_id: product.id,
        price: scrapeResult.data.price,
        stock_status: scrapeResult.data.stock_status,
        stock_quantity: scrapeResult.data.stock_quantity,
        scraped_at: finishedAt
      });
    } catch (dbErr) {
      console.error(
        `[CRITICAL DATA FAILURE] Could not insert price_history for product ${product.id}:`,
        dbErr.message
      );
      // Mark as failure if database insert failed
      scrapeResult.success = false;
      scrapeResult.error_type = 'VALIDATION';
      scrapeResult.error_message = `Database insertion rejected: ${dbErr.message}`;
    }

    if (scrapeResult.success && priceHistoryRow) {
      const outcomeStatus = scrapeResult.attempts > 1 ? 'retried' : 'success';

      try {
        await insertScrapeLog({
          product_id: product.id,
          run_id: runId,
          started_at: startedAt,
          finished_at: finishedAt,
          status: outcomeStatus,
          attempts: scrapeResult.attempts,
          http_status: scrapeResult.http_status || 200,
          duration_ms: durationMs,
          attempt_details: scrapeResult.attempt_details,
          price_history_id: priceHistoryRow.id
        });

        await updateProductScrapeStatus(product.id, outcomeStatus, finishedAt);
      } catch (logErr) {
        console.error(`[LOUD ERROR] Failed to record scrape log for product ${product.id}:`, logErr);
      }

      console.log(
        `[ScrapeRunner] ✅ Success for "${product.name}": ₹${scrapeResult.data.price} ` +
        `(${scrapeResult.data.stock_status}) in ${scrapeResult.attempts} attempt(s) [${durationMs}ms]`
      );

      return {
        productId: product.id,
        storeProductId: product.store_product_id,
        name: product.name,
        status: outcomeStatus,
        price: scrapeResult.data.price,
        stock_status: scrapeResult.data.stock_status,
        attempts: scrapeResult.attempts,
        duration_ms: durationMs
      };
    }
  }

  // 4. Handle Failure (All attempts failed or data rejected)
  // Write ONLY to scrape_logs. Write NOTHING to price_history.
  try {
    await insertScrapeLog({
      product_id: product.id,
      run_id: runId,
      started_at: startedAt,
      finished_at: finishedAt,
      status: 'failed',
      attempts: scrapeResult.attempts || 1,
      http_status: scrapeResult.http_status || null,
      error_type: scrapeResult.error_type || 'PARSE_ERROR',
      error_message: scrapeResult.error_message || 'Scrape attempts exhausted',
      duration_ms: durationMs,
      attempt_details: scrapeResult.attempt_details || [],
      price_history_id: null // Explicitly null on failure
    });

    await updateProductScrapeStatus(product.id, 'failed', finishedAt);
  } catch (logErr) {
    console.error(`[LOUD ERROR] Failed to record failure log for product ${product.id}:`, logErr);
  }

  console.warn(
    `[ScrapeRunner] ❌ Scrape failed for "${product.name}": [${scrapeResult.error_type}] ` +
    `${scrapeResult.error_message} (${scrapeResult.attempts} attempts)`
  );

  return {
    productId: product.id,
    storeProductId: product.store_product_id,
    name: product.name,
    status: 'failed',
    error_type: scrapeResult.error_type,
    error_message: scrapeResult.error_message,
    attempts: scrapeResult.attempts,
    duration_ms: durationMs
  };
}

/**
 * Runs a complete scrape cycle across all active tracked products (or a single product).
 * Enforces overlapping cycle prevention, duplicate-trigger prevention, concurrency limits,
 * and comprehensive result auditing.
 * 
 * @param {Object} [options]
 * @param {boolean} [options.force=false] - If true, bypasses the dedupe window
 * @param {string} [options.productId] - Optional: targets a single product
 * @param {boolean} [options.headed=false] - For headed testing
 * @param {Function} [options.scraperFn] - For mocking scraper in tests
 * @returns {Promise<{
 *   run_id: string,
 *   started_at: string,
 *   finished_at: string,
 *   duration_ms: number,
 *   counts: { total: number, success: number, retried: number, failed: number, skipped: number },
 *   results: Array<Object>,
 *   is_running?: boolean
 * }>}
 */
export async function runScrapeCycle(options = {}) {
  // Overlapping cycle guard
  if (isCycleRunning) {
    console.warn(`[ScrapeRunner] Scrape cycle already active (run_id: ${activeRunId}). Rejecting trigger.`);
    return {
      run_id: activeRunId,
      is_running: true,
      message: 'Scrape cycle already in progress'
    };
  }

  const runId = randomUUID();
  const cycleStart = Date.now();
  const startedAt = new Date().toISOString();

  isCycleRunning = true;
  activeRunId = runId;

  console.log(`\n================================================================`);
  console.log(`[ScrapeRunner] STARTING SCRAPE CYCLE: ${runId}`);
  console.log(`[ScrapeRunner] Concurrency: ${config.scrapeConcurrency} | Force: ${!!options.force}`);
  console.log(`================================================================`);

  try {
    // 1. Fetch products to scrape
    let products = [];
    if (options.products && Array.isArray(options.products)) {
      products = options.products;
    } else if (options.productId) {
      const single = await getProduct(options.productId);
      if (single) products = [single];
    } else {
      const listFn = options.listActiveProductsFn || listActiveProducts;
      products = await listFn();
    }

    // Safety guard: strictly separate test runs from live runs using unforgeable Symbol
    const isTestRun = options.testToken === RUNNER_TEST_TOKEN;

    if (isTestRun) {
      for (const p of products) {
        if (!p.store_product_id || !p.store_product_id.startsWith('test-')) {
          throw new Error(
            `[SAFETY GUARD VIOLATION] Test run attempted to scrape real product "${p.name}" ` +
            `(store_product_id: ${p.store_product_id}). Test products must have store IDs starting with 'test-'.`
          );
        }
      }
    } else {
      // In live runs, reject any accidental test products
      for (const p of products) {
        if (p.store_product_id && p.store_product_id.startsWith('test-')) {
          throw new Error(
            `[SAFETY GUARD VIOLATION] Live scrape cycle attempted to process test product "${p.name}" ` +
            `(store_product_id: ${p.store_product_id}).`
          );
        }
      }
    }

    if (products.length === 0) {
      console.log('[ScrapeRunner] No active products to scrape.');
      return {
        run_id: runId,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - cycleStart,
        counts: { total: 0, success: 0, retried: 0, failed: 0, skipped: 0 },
        results: []
      };
    }

    console.log(`[ScrapeRunner] Found ${products.length} product(s) to process.`);

    // 2. Process products with concurrency limit
    const results = await mapConcurrent(
      products,
      config.scrapeConcurrency,
      (product) => processProductScrape(product, runId, options)
    );

    // 3. Compile summary metrics
    const counts = {
      total: products.length,
      success: 0,
      retried: 0,
      failed: 0,
      skipped: 0
    };

    for (const res of results) {
      if (res.status === 'success') counts.success++;
      else if (res.status === 'retried') counts.retried++;
      else if (res.status === 'failed') counts.failed++;
      else if (res.status === 'skipped') counts.skipped++;
    }

    const durationMs = Date.now() - cycleStart;
    const finishedAt = new Date().toISOString();

    console.log(`\n----------------------------------------------------------------`);
    console.log(`[ScrapeRunner] SCRAPE CYCLE COMPLETED: ${runId}`);
    console.log(`[ScrapeRunner] Duration: ${durationMs}ms`);
    console.log(
      `[ScrapeRunner] Outcomes: Total=${counts.total}, Success=${counts.success}, ` +
      `Retried=${counts.retried}, Failed=${counts.failed}, Skipped=${counts.skipped}`
    );
    console.log(`================================================================\n`);

    return {
      run_id: runId,
      started_at: startedAt,
      finished_at: finishedAt,
      duration_ms: durationMs,
      counts,
      results
    };
  } finally {
    isCycleRunning = false;
    activeRunId = null;
  }
}
