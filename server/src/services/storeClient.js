import config from '../config/index.js';
import { scrapeProductPage } from './browserScraper.js';
import { parseProductHtml, ParseError } from './parser.js';
import { validateScrapedProduct, ValidationError } from './validator.js';

// In-memory catalog cache with 10-minute TTL for search queries
let catalogCache = {
  items: [],
  cachedAt: 0,
  ttlMs: 10 * 60 * 1000 // 10 minutes
};

/**
 * Classifies an error into one of the designated core error types:
 * NETWORK, TIMEOUT, HTTP_5XX, HTTP_4XX, RATE_LIMITED, PLACEHOLDER,
 * PARSE_ERROR, VALIDATION, IDENTITY_MISMATCH.
 * 
 * @param {Error} error
 * @param {number} [httpStatus]
 * @returns {string} Error category
 */
export function classifyError(error, httpStatus = null) {
  if (error instanceof ValidationError) {
    return error.errorType; // 'VALIDATION' or 'IDENTITY_MISMATCH'
  }
  if (error instanceof ParseError) {
    return error.errorType; // 'PLACEHOLDER', 'PARSE_ERROR', or 'HTTP_4XX'
  }

  const message = (error?.message || '').toLowerCase();

  if (httpStatus === 429 || message.includes('429') || message.includes('rate limit')) {
    return 'RATE_LIMITED';
  }
  if (httpStatus === 404 || message.includes('404') || message.includes('not found')) {
    return 'HTTP_4XX';
  }
  if (httpStatus && httpStatus >= 400 && httpStatus < 500) {
    return 'HTTP_4XX';
  }
  if (httpStatus && httpStatus >= 500) {
    return 'HTTP_5XX';
  }
  if (message.includes('timeout') || message.includes('timed out') || message.includes('exceeded')) {
    return 'TIMEOUT';
  }
  if (
    message.includes('net::') ||
    message.includes('econnrefused') ||
    message.includes('enotfound') ||
    message.includes('network') ||
    message.includes('fetch failed')
  ) {
    return 'NETWORK';
  }

  return 'PARSE_ERROR';
}

/**
 * Calculates exponential backoff wait duration with jitter.
 * @param {number} attempt
 * @param {number} [retryAfterSec]
 * @returns {number} Milliseconds to sleep
 */
export function calculateBackoff(attempt, retryAfterSec = null) {
  if (retryAfterSec && retryAfterSec > 0) {
    return retryAfterSec * 1000;
  }
  const base = Math.min(1000 * Math.pow(2, attempt - 1), 6000);
  const jitter = Math.random() * 400;
  return Math.round(base + jitter);
}

/**
 * Executes the full fetch-parse-validate pipeline for a product with retries,
 * hard timeouts, jittered exponential backoffs, and an overall time budget.
 * 
 * Performs NO database writes.
 * 
 * @param {Object} product - Product record { store_product_id, name, url }
 * @param {Object} [options]
 * @param {boolean} [options.headed=false]
 * @param {Function} [options.scraperFn] - Mock injection for tests
 * @returns {Promise<{
 *   success: boolean,
 *   attempts: number,
 *   data?: Object,
 *   http_status?: number,
 *   error_type?: string,
 *   error_message?: string,
 *   duration_ms: number,
 *   attempt_details: Array<Object>
 * }>}
 */
export async function scrapeProduct(product, options = {}) {
  const maxAttempts = options.maxAttempts || config.maxAttempts;
  const timeoutMs = options.timeoutMs || config.requestTimeoutMs;
  const scraper = options.scraperFn || scrapeProductPage;

  // Enforce overall per-product budget so one product never hangs the whole run
  // Budget generously covers maxAttempts, backoff pauses, and network overhead
  const totalBudgetMs = options.totalBudgetMs || (timeoutMs * maxAttempts) + 10000;
  const overallStart = Date.now();

  const attemptDetails = [];
  let lastErrorType = null;
  let lastErrorMessage = null;
  let lastHttpStatus = null;

  // Construct target URL
  const targetUrl = product.url || `${config.storeBaseUrl}/product/${product.store_product_id}`;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Check remaining budget
    if (Date.now() - overallStart >= totalBudgetMs) {
      lastErrorType = 'TIMEOUT';
      lastErrorMessage = `Overall product time budget of ${totalBudgetMs}ms exhausted before attempt ${attempt}`;
      break;
    }

    const attemptStart = Date.now();
    let currentHttpStatus = null;

    try {
      // 1. Fetch rendered DOM
      const scrapeResult = await scraper(targetUrl, {
        timeout: timeoutMs,
        headed: options.headed
      });

      currentHttpStatus = scrapeResult.httpStatus || 200;
      lastHttpStatus = currentHttpStatus;

      // Handle 404 or client errors immediately
      if (currentHttpStatus === 404) {
        throw new ParseError(`Product not found (HTTP 404)`, 'HTTP_4XX');
      }

      // 2. Parse HTML
      const parsedData = parseProductHtml(scrapeResult.html, product);

      // 3. Validate
      validateScrapedProduct(parsedData, product);

      const duration = Date.now() - attemptStart;
      attemptDetails.push({
        attempt,
        at: new Date().toISOString(),
        outcome: 'success',
        duration_ms: duration,
        http_status: currentHttpStatus
      });

      return {
        success: true,
        attempts: attempt,
        data: parsedData,
        http_status: currentHttpStatus,
        duration_ms: Date.now() - overallStart,
        attempt_details: attemptDetails
      };
    } catch (err) {
      const duration = Date.now() - attemptStart;
      const errorType = classifyError(err, currentHttpStatus);
      const errorMessage = err.message || 'Unknown scrape failure';

      lastErrorType = errorType;
      lastErrorMessage = errorMessage;

      attemptDetails.push({
        attempt,
        at: new Date().toISOString(),
        outcome: 'failed',
        error_type: errorType,
        error_message: errorMessage,
        duration_ms: duration,
        http_status: currentHttpStatus
      });

      // Permanent errors: do NOT retry on HTTP 404
      if (errorType === 'HTTP_4XX' && currentHttpStatus === 404) {
        break;
      }

      // If we still have attempts left and remaining budget, wait with backoff
      if (attempt < maxAttempts) {
        const remainingBudget = totalBudgetMs - (Date.now() - overallStart);
        if (remainingBudget <= 1000) {
          lastErrorType = 'TIMEOUT';
          lastErrorMessage = `Insufficient remaining budget (${remainingBudget}ms) for retry`;
          break;
        }

        const waitMs = Math.min(calculateBackoff(attempt), remainingBudget - 500);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }

  return {
    success: false,
    attempts: attemptDetails.length,
    http_status: lastHttpStatus,
    error_type: lastErrorType || 'PARSE_ERROR',
    error_message: lastErrorMessage || 'Scrape attempts exhausted',
    duration_ms: Date.now() - overallStart,
    attempt_details: attemptDetails
  };
}

/**
 * Searches the mock store by fetching catalog pages via plain HTTP (no challenge required),
 * caching entries in memory with a short TTL, and filtering server-side by query.
 * 
 * @param {string} query - Search term (minimum 2 characters)
 * @returns {Promise<Array<Object>>} Normalized products
 */
export async function searchProducts(query) {
  if (!query || typeof query !== 'string' || query.trim().length < 2) {
    return [];
  }

  const normalizedQuery = query.trim().toLowerCase();
  const now = Date.now();

  // Populate or refresh catalog cache if expired
  if (catalogCache.items.length === 0 || now - catalogCache.cachedAt > catalogCache.ttlMs) {
    try {
      const fetchedItems = [];
      // Fetch the first 5 pages (100 products) to provide a rich catalog search
      for (let page = 1; page <= 5; page++) {
        const res = await fetch(`${config.storeBaseUrl}/api/catalog?page=${page}&pageSize=20`);
        if (!res.ok) break;
        const data = await res.json();
        if (data.items && Array.isArray(data.items)) {
          fetchedItems.push(...data.items);
        } else {
          break;
        }
      }

      if (fetchedItems.length > 0) {
        catalogCache.items = fetchedItems;
        catalogCache.cachedAt = now;
      }
    } catch (e) {
      console.error('[Search Error] Failed to refresh catalog cache:', e.message);
      // If network fails but we have stale cache, continue using stale cache
    }
  }

  // Filter cached catalog items server-side
  const matches = catalogCache.items.filter((item) => {
    const nameMatch = (item.name || '').toLowerCase().includes(normalizedQuery);
    const catMatch = (item.category || '').toLowerCase().includes(normalizedQuery);
    const brandMatch = (item.brand || '').toLowerCase().includes(normalizedQuery);
    const skuMatch = (item.sku || '').toLowerCase().includes(normalizedQuery);
    return nameMatch || catMatch || brandMatch || skuMatch;
  });

  // Normalize product objects
  return matches.map((item) => ({
    store_product_id: String(item.id),
    name: item.name,
    url: `${config.storeBaseUrl}/product/${item.id}`,
    image_url: item.image || null,
    category: item.category || null,
    brand: item.brand || null,
    sku: item.sku || null,
    description: item.description || null
  }));
}
