# Engineering Design Note: Price Tracker

**Author**: Priyanshu  
**System**: Production Automated E-Commerce Price Tracker  
**Date**: September 2026

---

## 1. Reliability Techniques & Architecture

When building an automated price-tracking service against an e-commerce store with client-side anti-scraping defenses, reliability requires defensive engineering at every layer:

1. **FIFO Serialized Queue (`concurrency: 1`)**:
   All browser scrapes run sequentially in a FIFO queue. This caps memory consumption and prevents rate-limit storms. The queue has a limit of 10 jobs with 1 reserved slot for scheduled cron cycles, preventing manual user refreshes from crowding out scheduled scrapes.
2. **Zero DB Pollution on Scrape Failures**:
   Every scrape attempt records detailed audit telemetry in `scrape_logs`, but failed, timed-out, or invalid attempts **never** write to `price_history`. Speculative, null, or zero prices never enter historical charts.
3. **Same-State Active Price Agreement Check**:
   The scraper extracts the parsed active price from the DOM and verifies that it agrees with the raw text inside the active price container in the exact same page state. Any disagreement rejects the attempt as `PRICE_MISMATCH` and triggers a clean retry.
4. **MRP Plausibility Bounds**:
   Extracted prices must fall between 10% and 200% of the product MRP. This protects the database against single-digit parser truncation errors without blocking genuine deep discounts.
5. **Honest Cache with Direct Lookup Fallback**:
   Because the upstream catalog API shuffles items across paginated requests, a 20-page crawl only discovers about 635 of 1000 items. The cache honestly marks `isPartial: true`, the UI displays a warning notice, and searches for unindexed products automatically fall back to direct lookup by numeric store ID.

---

## 2. Why a Headless Browser Was Strictly Required

Based on empirical evidence documented in `docs/STORE_ANALYSIS.md`, lightweight HTTP requests (such as Cheerio or Axios) cannot extract price or stock from this store:

- The initial HTML response is an empty React shell (`<div id="root"></div>`).
- Public JSON endpoints (`/api/catalog`, `/api/product/:id`) return only static metadata (name, brand, SKU, specs); price and stock are excluded.
- Prices load only after satisfying an interaction challenge requiring mouse movement (about 8 coordinate moves) and dwell time (about 600 ms) over the price block followed by clicking a reveal button.
- The DOM contains hidden decoy price elements (`display: none`) with fake numbers that deceive static HTML scrapers.

---

## 3. Problems I Faced and How I Solved Them

| Problem                                         | Cause                                                                                                                                                                              | Fix                                                                                                                                                                                                 | Result                                                                                                                                                                              |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Interaction stalls (10–12s timeouts)**        | A `.cookie-overlay` banner covered the viewport and blocked mouse events on the price area.                                                                                        | First attempted hiding/removing the overlay, which did worse (30% vs 20% stalls; 7/25 stalls vs 5/25 unmitigated). Final fix clicks the real Accept button and waits for the enabled Reveal button. | Stalls dropped to 0/25 (0%) in `single_5x5_benchmark_2026-09-19T16-11-45-206Z.json` (84% first-try success [21/25], 16% retried [4/25]; min 2666 ms, median 4179 ms, max 34553 ms). |
| **Price truncation (7, 1, 7.92)**               | Three bugs: split-carrier `<span>` tags stripped with spaces (`7 1 8 1 9` -> `7`), European period notation (`61.925`), and undecoded `&nbsp;` entities.                           | Used captured HTML as test fixtures; stripped inline tags without spaces; added digit collapsing; enforced same-state agreement checks and 10%–200% MRP plausibility.                               | All three truncation bugs eliminated; 100% agreement on benchmark tests.                                                                                                            |
| **Price differs between reads of same product** | The store dynamically re-quotes prices on each session/load (for product 989, price varied between ₹53,691 and ₹71,819, and MRP changed proportionally from ₹170,998 to ₹228,720). | Accepted dynamic re-quoting as intended store behavior; stored each validated read as an immutable point-in-time quote in `price_history`.                                                          | Reliable historical price tracking without artificial smoothing.                                                                                                                    |
| **Render 502 Bad Gateway crashes**              | `QueueFullError` was unimported in `cron.js`; when the queue filled, the unhandled ReferenceError crashed the Node process. Tests never called this route.                         | Imported `QueueFullError`, added async error wrappers, added integration tests for the cron route, and added process-level error handlers.                                                          | Server remains healthy under load; returns clean HTTP 429 when queue is full.                                                                                                       |
| **Search instability & missing products**       | Store `/api/catalog` shuffles pages on every request without sorting, so a 20-page crawl returned duplicates and omitted products (finding ~628–643 of 1000 items).                | Crawled all 20 pages with 4 concurrent workers and retries; marked cache `isPartial: true` when count < 1000; added UI notice; added fallback direct lookup by store ID.                            | Deterministic search; product 459 always findable; honest status in UI.                                                                                                             |
| **"basket" junk product tracked**               | The manual tracking form accepted any arbitrary string without validation.                                                                                                         | Added validation enforcing numeric store IDs or valid product URLs in backend and frontend.                                                                                                         | Prevents invalid products from entering the tracking queue.                                                                                                                         |
| **Vercel CORS failure**                         | A trailing slash in my `FRONTEND_ORIGIN` environment variable setting caused CORS comparison failures.                                                                             | Server normalizes origins with `normalizeOrigin()` by trimming whitespace and stripping trailing slashes.                                                                                           | Clean CORS matching regardless of trailing slash in env var.                                                                                                                        |

---

## 4. Key Trade-offs

- **Headless Chromium vs. Memory Footprint**:
  Locally, Node plus Chromium measured about 345 MB peak memory during benchmarking. On Render's 512 MB free tier, headroom is limited and real memory usage under Docker remains unmeasured. Running with `concurrency: 1` avoids memory exhaustion.
- **Scrape Duration**:
  Scrapes typically take a few seconds (median 4,179 ms in the 25-run benchmark), extending up to 34,553 ms when retries and exponential backoff are needed.
- **Catalog Crawl vs. Search Speed**:
  A cold 20-page catalog crawl takes about 6.3 to 8.8 seconds. Caching items in memory yields 2 to 8 ms warm search responses.

---

## 5. What the AI Tools Got Wrong and How It Was Corrected

1. **Fabricated Benchmark Rows & Failure Explanations**:
   When Product 120 failed due to a hardcoded name mismatch, the AI tool invented an explanation ("out-of-stock item with no price element") without checking `attempt_details`. Later, it fabricated benchmark rows 11 and 12 for product 120 instead of running real scrapes.  
   _Correction_: Established the rule to report only from raw execution files. Every benchmark number is copied directly from saved JSON evidence.
2. **Polluting Live Database with Fake Test Rows**:
   Test scripts executed real scrape cycles that wrote a fake price of 500 and two log rows under real product 459 in my Supabase database (which I found by querying and deleted). A later test toggled `is_active = false` on live products.  
   _Correction_: Replaced live database mutation with an injected product loader and created test guards (`test-` prefix requirement plus an unforgeable Symbol token).
3. **Layered Price Truncation Bugs**:
   The AI parser repeatedly truncated prices: first by replacing `<span>` tags with whitespace (turning `7 1 8 1 9` into `7`), then by treating European period-separated thousands as decimals (`61.925` -> `61.92`), and then failing on undecoded `&nbsp;` characters.  
   _Correction_: Captured real failing DOM HTML files as permanent unit test fixtures, added digit collapsing, and introduced MRP plausibility bounds (10% to 200%).
4. **Unsupported Chromium `--single-process` Flag**:
   The AI tool added `--single-process` to Chromium launch arguments. Because Playwright does not officially support `--single-process` and flags it as unstable, I removed it before deploying.
5. **Exposing Cron Secret in Client Bundle**:
   The AI tool added a "Trigger Cron Scrape" button to the frontend that exposed `CRON_SECRET` in client JavaScript. I caught this using `git grep`, deleted the button, built a public `POST /api/products/:id/refresh` endpoint protected by a 5-minute per-product cooldown and queue cap, and rotated the secret.
6. **Ineffective Timeout Increase**:
   The AI increased `page.waitForFunction` to 16 seconds to avoid stalls, but the change had zero effect because a separate page-level default timeout of 10 seconds still aborted the page at exactly 10,000 ms. Caught by inspecting attempt durations.
7. **20 x 20 Catalog Assumption (400 != 1000)**:
   The AI tool assumed fetching 20 pages at the default page size of 20 retrieved the entire 1000-item catalog, silently omitting 600 items (20 x 20 = 400). I updated it to fetch `pageSize=50`. However, the catalog remains partial (~635 items) due to upstream store shuffling, which is now honestly flagged rather than claimed as fully fixed.
