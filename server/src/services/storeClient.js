import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import config from '../config/index.js';
import { scrapeProductPage } from './browserScraper.js';
import { parseProductHtml, parsePriceText, ParseError } from './parser.js';
import { validateScrapedProduct, ValidationError } from './validator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FULL_TTL_MS = 30 * 60 * 1000; // 30 minutes full TTL
const PARTIAL_TTL_MS = 60 * 1000;   // 1 minute degraded TTL for partial results

// In-memory catalog cache with concurrency management, full vs partial TTL, and stats tracking
export const catalogCache = {
  items: [],
  cachedAt: 0,
  ttlMs: FULL_TTL_MS,
  isPartial: false,
  message: null,
  pageSize: 50,
  pageCount: 0,
  storeTotal: 0,
  fetchInProgress: null
};

export function getCatalogStats() {
  return {
    itemCount: catalogCache.items.length,
    pageSize: catalogCache.pageSize,
    pageCount: catalogCache.pageCount,
    storeTotal: catalogCache.storeTotal,
    has459: catalogCache.items.some((it) => String(it.id) === '459'),
    isPartial: catalogCache.isPartial,
    ttlMs: catalogCache.ttlMs,
    cachedAt: catalogCache.cachedAt,
    message: catalogCache.message
  };
}

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
    let scrapeResult = null;

    try {
      // 1. Fetch rendered DOM
      scrapeResult = await scraper(targetUrl, {
        timeout: timeoutMs,
        headed: options.headed
      });

      currentHttpStatus = scrapeResult.httpStatus || 200;
      lastHttpStatus = currentHttpStatus;

      // Handle HTTP client/server errors immediately
      if (currentHttpStatus === 404) {
        throw new ParseError(`Product not found (HTTP 404)`, 'HTTP_4XX');
      }
      if (currentHttpStatus >= 500) {
        throw new Error(`Upstream server returned HTTP ${currentHttpStatus}`);
      }
      if (currentHttpStatus >= 400) {
        throw new Error(`Upstream server returned HTTP ${currentHttpStatus}`);
      }

      // 2. Parse HTML
      const parsedData = parseProductHtml(scrapeResult.html, product);

      // 2b. Same-state Active Price Agreement Check (reads active price twice in same page state)
      if (scrapeResult.renderedPriceText) {
        let renderedPrice = null;
        try {
          renderedPrice = parsePriceText(scrapeResult.renderedPriceText);
        } catch (pErr) {
          throw new ParseError(
            `PRICE_MISMATCH: Failed to parse rendered price text "${scrapeResult.renderedPriceText}": ${pErr.message}`,
            'PRICE_MISMATCH'
          );
        }

        if (parsedData.price !== renderedPrice) {
          throw new ParseError(
            `PRICE_MISMATCH: Parsed price (₹${parsedData.price}) does not match rendered element text price (₹${renderedPrice}) in same page state`,
            'PRICE_MISMATCH'
          );
        }
      }

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
        data: {
          ...parsedData,
          rendered_price_text: scrapeResult?.renderedPriceText || null,
          all_dom_price_elements: scrapeResult?.allDomPriceElements || []
        },
        http_status: currentHttpStatus,
        duration_ms: Date.now() - overallStart,
        attempt_details: attemptDetails
      };
    } catch (err) {
      const duration = Date.now() - attemptStart;
      const errorType = classifyError(err, currentHttpStatus);
      const errorMessage = err.message || 'Unknown scrape failure';

      // Save raw HTML of every attempt rejected by validation or agreement check to docs/evidence/rejected/
      if (
        scrapeResult?.html &&
        (errorType === 'VALIDATION' ||
         errorType === 'PRICE_MISMATCH' ||
         errorMessage.includes('Plausibility Failure') ||
         errorMessage.includes('PRICE_MISMATCH'))
      ) {
        try {
          const rejectedDir = path.resolve(__dirname, '../../../docs/evidence/rejected');
          if (!fs.existsSync(rejectedDir)) {
            fs.mkdirSync(rejectedDir, { recursive: true });
          }
          const safeId = String(product.store_product_id || product.id || 'unknown');
          const filename = `rejected_${safeId}_att${attempt}_${Date.now()}.html`;
          fs.writeFileSync(path.join(rejectedDir, filename), scrapeResult.html, 'utf8');
          console.warn(`[StoreClient] 💾 Saved rejected attempt HTML: docs/evidence/rejected/${filename}`);
        } catch (saveErr) {
          console.warn('[StoreClient] Failed to save rejected HTML:', saveErr.message);
        }
      }

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
        attemptDetails[attemptDetails.length - 1].backoff_wait_ms = waitMs;
        if (typeof options.onBackoffWait === 'function') {
          options.onBackoffWait(waitMs, attempt + 1);
        }
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
 * Refreshes the catalog cache by fetching ALL pages with controlled concurrency (~4),
 * retries on 429/failures with backoff, and deterministic sorting by ID.
 * If any page fails after retries, marks cache partial with degraded 60s TTL.
 * 
 * @param {boolean} [force=false]
 * @returns {Promise<typeof catalogCache>}
 */
export async function refreshCatalogCache(force = false) {
  const now = Date.now();
  if (
    !force &&
    catalogCache.items.length > 0 &&
    now - catalogCache.cachedAt < catalogCache.ttlMs
  ) {
    return catalogCache;
  }

  // Deduplicate concurrent refresh calls
  if (catalogCache.fetchInProgress) {
    return catalogCache.fetchInProgress;
  }

  catalogCache.fetchInProgress = (async () => {
    try {
      const pageSize = 50;
      // 1. Fetch initial page to discover store total and total pages
      let firstData = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await fetch(`${config.storeBaseUrl}/api/catalog?page=1&pageSize=${pageSize}`);
          if (res.status === 429) {
            const wait = Math.max(parseInt(res.headers.get('retry-after') || '1', 10) * 1000, 400 * attempt);
            await new Promise((r) => setTimeout(r, wait));
            continue;
          }
          if (res.ok) {
            firstData = await res.json();
            break;
          }
        } catch (e) {
          if (attempt === 3) throw e;
          await new Promise((r) => setTimeout(r, 250 * attempt));
        }
      }

      if (!firstData || !Array.isArray(firstData.items)) {
        throw new Error('Failed to retrieve initial catalog page');
      }

      const storeTotal = firstData.total || 1000;
      const actualPageSize = firstData.pageSize || pageSize;
      const totalPages = firstData.pages || Math.ceil(storeTotal / actualPageSize);

      catalogCache.storeTotal = storeTotal;
      catalogCache.pageSize = actualPageSize;
      catalogCache.pageCount = totalPages;

      const itemsMap = new Map();
      for (const it of firstData.items) {
        if (it && it.id != null) itemsMap.set(String(it.id), it);
      }

      // 2. Fetch remaining pages (2..totalPages) with limited concurrency (~4)
      const remainingPages = [];
      for (let p = 2; p <= totalPages; p++) {
        remainingPages.push(p);
      }

      let anyPageFailed = false;
      const failedPages = [];

      async function fetchPageWithRetry(page, maxRetries = 3) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            const res = await fetch(`${config.storeBaseUrl}/api/catalog?page=${page}&pageSize=${actualPageSize}`);
            if (res.status === 429) {
              const retrySec = parseInt(res.headers.get('retry-after') || '1', 10);
              const waitMs = Math.max(retrySec * 1000, 400 * attempt);
              await new Promise((r) => setTimeout(r, waitMs));
              continue;
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (Array.isArray(data.items)) {
              return data.items;
            }
            throw new Error('Missing items array');
          } catch (err) {
            if (attempt === maxRetries) {
              failedPages.push(page);
              anyPageFailed = true;
              return [];
            }
            await new Promise((r) => setTimeout(r, 200 * attempt));
          }
        }
        return [];
      }

      const CONCURRENCY = 4;
      async function worker() {
        while (remainingPages.length > 0) {
          const page = remainingPages.shift();
          const items = await fetchPageWithRetry(page);
          for (const it of items) {
            if (it && it.id != null) {
              itemsMap.set(String(it.id), it);
            }
          }
          await new Promise((r) => setTimeout(r, 50));
        }
      }

      await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

      // 3. Sort catalog items deterministically by numeric ID
      const allItems = Array.from(itemsMap.values());
      allItems.sort((a, b) => Number(a.id) - Number(b.id));

      catalogCache.items = allItems;
      catalogCache.cachedAt = Date.now();

      // Make cache honest: isPartial is true if any page failed OR unique items count is below store total
      const isCountPartial = allItems.length < storeTotal;
      if (anyPageFailed || isCountPartial) {
        catalogCache.isPartial = true;
        catalogCache.ttlMs = isCountPartial && !anyPageFailed ? FULL_TTL_MS : PARTIAL_TTL_MS;
        catalogCache.message = `Partial catalog cached (${allItems.length}/${storeTotal} unique products discovered due to upstream store shuffling${anyPageFailed ? `; failed pages: ${failedPages.join(', ')}` : ''}).`;
        console.warn(`[StoreClient] ${catalogCache.message}`);
      } else {
        catalogCache.isPartial = false;
        catalogCache.ttlMs = FULL_TTL_MS;
        catalogCache.message = null;
        console.log(`[StoreClient] Full catalog cached: ${allItems.length} unique items across ${totalPages} pages. Full TTL: ${FULL_TTL_MS / 60000}m.`);
      }

      return catalogCache;
    } catch (err) {
      console.error('[StoreClient] Full catalog fetch error:', err.message);
      catalogCache.isPartial = true;
      catalogCache.ttlMs = PARTIAL_TTL_MS;
      catalogCache.message = `Catalog fetch failed: ${err.message}. Short TTL applied.`;
      return catalogCache;
    } finally {
      catalogCache.fetchInProgress = null;
    }
  })();

  return catalogCache.fetchInProgress;
}

/**
 * Searches the catalog with:
 * - Multi-word case-insensitive matching: all words must appear in name + brand + sku (or query matches ID)
 * - Fallback to direct lookup (numeric ID) when zero matches are found in cache
 * - Deterministic ordering: exact name match first (case-insensitive), then alphabetical by name, then by ID
 * 
 * @param {string} query - Search term
 * @param {Object} [options]
 * @param {boolean} [options.forceRefresh=false]
 * @returns {Promise<Array<Object>>}
 */
export async function searchProducts(query, options = {}) {
  if (!query || typeof query !== 'string' || query.trim().length < 2) {
    return [];
  }

  const normalizedQuery = query.trim().toLowerCase();
  const queryWords = normalizedQuery.split(/\s+/).filter(Boolean);

  await refreshCatalogCache(options.forceRefresh || false);

  // Multi-word case-insensitive filter: every word must appear in name + brand + sku (or exact ID match)
  const matches = catalogCache.items.filter((item) => {
    const haystack = `${item.name || ''} ${item.brand || ''} ${item.sku || ''}`.toLowerCase();
    const wordsMatch = queryWords.every((w) => haystack.includes(w));
    const idMatch = String(item.id) === query.trim();
    return wordsMatch || idMatch;
  });

  // Fallback: when search finds nothing, fall back to direct lookup for numeric ID
  if (matches.length === 0) {
    const trimmed = query.trim();
    const numericMatch = trimmed.match(/^\d+$/) || trimmed.match(/DOM-10?(\d+)/i);
    const targetId = numericMatch ? (numericMatch[1] || numericMatch[0]) : null;

    if (targetId) {
      try {
        const directRes = await fetch(`${config.storeBaseUrl}/api/product/${targetId}`);
        if (directRes.ok) {
          const directItem = await directRes.json();
          if (directItem && directItem.id != null) {
            const idStr = String(directItem.id);
            if (!catalogCache.items.some((it) => String(it.id) === idStr)) {
              catalogCache.items.push(directItem);
              catalogCache.items.sort((a, b) => Number(a.id) - Number(b.id));
            }
            matches.push(directItem);
          }
        }
      } catch (directErr) {
        console.warn(`[StoreClient] Direct product lookup fallback failed for ${targetId}:`, directErr.message);
      }
    }
  }

  // Deterministic sort:
  // 1. Exact name match first (case-insensitive)
  // 2. Then alphabetical by name
  // 3. Then by numeric id
  matches.sort((a, b) => {
    const aExact = (a.name || '').toLowerCase() === normalizedQuery ? 0 : 1;
    const bExact = (b.name || '').toLowerCase() === normalizedQuery ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;
    const nameCmp = (a.name || '').localeCompare(b.name || '');
    if (nameCmp !== 0) return nameCmp;
    return Number(a.id) - Number(b.id);
  });

  // Normalize product objects with store_product_id
  return matches.map((item) => ({
    id: String(item.id),
    store_product_id: String(item.id),
    name: item.name,
    url: `${config.storeBaseUrl}/product/${item.id}`,
    image_url: item.image || null,
    category: item.category || null,
    brand: item.brand || null,
    sku: item.sku || null,
    description: item.description || null,
    price: item.price != null && item.price > 0 ? item.price : null,
    mrp: item.mrp != null && item.mrp > 0 ? item.mrp : null
  }));
}
