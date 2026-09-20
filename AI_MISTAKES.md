# Running Log of AI Mistakes, False Assumptions, and Corrections

This document tracks all initial mistakes, incorrect assumptions, selector misidentifications, and design missteps encountered during the development of the Product Price Tracker, along with their detection methods and corrections.

---

### Entry 1: CommonJS `require` in an ES Module Package
- **What went wrong**: During store investigation, temporary scratch scripts inside `/server` were written using CommonJS `const fs = require('fs')`, but `server/package.json` specifies `"type": "module"`.
- **How it was detected**: Node.js runtime threw `ReferenceError: require is not defined in ES module scope`.
- **How it was fixed**: Converted all backend scripts and services to strict ES Module syntax using `import fs from 'fs'` and `import.meta.url`.

### Entry 2: Presuming Mock Store Query Parameters Supported Server-Side Filtering
- **What went wrong**: Assumed that the mock store's `/api/catalog` endpoint might accept search queries like `?q=query` or `?search=query` or `?name=query`.
- **How it was detected**: Executed HTTP requests against `/api/catalog?q=sling` and inspected the JSON response; the endpoint returned the exact same 1000 items and page 1 items regardless of the query string.
- **How it was fixed**: Documented in `STORE_ANALYSIS.md` that product search must be implemented by fetching catalog pages into an in-memory cache with a TTL (e.g., 10 minutes) and performing case-insensitive substring matching server-side across `name`, `category`, and `brand`.

### Entry 3: Decoy Price Elements (Honey-Pots) in the Product DOM
- **What went wrong**: An initial scan of the product page DOM identified obvious selectors like `.price-value` and `span[data-price="true"]`.
- **How it was detected**: Closer inspection of element computed styles and text content revealed these elements are hidden (`display: none` and `aria-hidden="true"`) and contain decoy, static numbers (e.g., ₹7,854 vs the real ₹6,727).
- **How it was fixed**: Formulated extraction logic in `STORE_ANALYSIS.md` and Level B3 specs to strictly evaluate element visibility, reject elements with `display: none` or strikethrough/mrp classes, and target the unhidden active price container (`output` or `span.pv-*`).

### Entry 4: Price Text Obfuscation with Zero-Width Characters and Unicode
- **What went wrong**: Naive numeric parsing (`parseFloat(text.replace('₹', ''))`) would produce `NaN` because the store deliberately intersperses zero-width spaces (`\u200B`), non-breaking spaces (`\xA0`), full-width Unicode numerals, and varying currency prefixes (`Rs.`, `₹`).
- **How it was detected**: Observed `Sample result: visiblePriceText: '₹\u200b6\u200b,\u200b7\u200b2\u200b7'` and `Rs.\xA06,727.00` in Playwright DOM inspections.
- **How it was fixed**: Designed a multi-stage sanitizer for the parser in Level B3: stripping invisible and non-breaking characters, normalizing full-width digits, identifying decimal vs thousand separators, and verifying `price > 0`.

### Entry 5: PostgREST HEAD Requests Return 204 for Non-Existent Tables
- **What went wrong**: In the initial `scripts/verify-db.js`, `supabase.from(table).select('*', { head: true })` was used to test table presence. PostgREST returns HTTP 204 No Content for HEAD requests without validating the table in the schema cache, producing a false positive that tables existed.
- **How it was detected**: Running `tests/db.test.js` failed with error `PGRST205: Could not find the table 'public.products' in the schema cache`.
- **How it was fixed**: Replaced `{ head: true }` with `.select('*').limit(1)`, forcing PostgREST to perform an actual schema-validated GET query that reliably fails when the table is not present.

### Entry 6: ReferenceError in `verify-db.js` After Modifying Query Destructuring
- **What went wrong**: While updating `scripts/verify-db.js` to execute `.select('*').limit(1)`, the variable `count` was removed from the destructured return object (`const { data, error }`), but the success logging statement on line 37 still referenced `count`. This caused the catch block to intercept a `ReferenceError: count is not defined` even though the Supabase query itself had succeeded.
- **How it was detected**: The user ran `npm --prefix server run db:verify`, and the script reported `UNEXPECTED ERROR - count is not defined`.
- **How it was fixed**: Updated the query call to `const { data, error, count } = await supabase.from(table).select('*', { count: 'exact' }).limit(1)`, properly restoring the `count` variable and confirming successful table access.

### Entry 7: Chromium `--single-process` Flag Causing Tab Crashes on Windows
- **What went wrong**: In `browserScraper.js`, `--single-process` was included in the Chromium launch arguments. On Windows environments, `--single-process` causes Chromium's internal tab process to terminate abruptly upon context or page navigation.
- **How it was detected**: Running `scripts/test-headless-live.js` failed with `page.goto: Target page, context or browser has been closed`.
- **How it was fixed**: Removed `--single-process` from the launch arguments while retaining memory-safe flags (`--disable-dev-shm-usage`, `--no-sandbox`), enabling headless Chromium to operate reliably.

### Entry 8: Automated Tests Polluting Live Database Rows
- **What went wrong**: In `server/tests/runner.test.js`, runner integration tests called `runScrapeCycle()` which queried `listActiveProducts({ force: true })` against the live Supabase database and executed scrape cycles that inserted fake scrape history (price: 500) and mock scrape logs under the user's real product (store product ID `459`).
- **How it was detected**: The user inspected their live Supabase database after `npm test` and discovered a fake price history row (`price: 500`) and two 0-1ms scrape log rows associated with product `459`.
- **How it was fixed**:
  1. Updated `runScrapeCycle(options)` to accept an explicit `products` array and added a `testOnly: true` enforcement flag.
  2. Implemented a strict safety guard in `runScrapeCycle` that throws a `[SAFETY GUARD VIOLATION]` exception if `testOnly: true` is set and any product lacks a `test-` prefixed `store_product_id`.
  3. Refactored `server/tests/runner.test.js` to strictly use products with `store_product_id: 'test-runner-prod-1'` (and test names), never call `listActiveProducts({ force: true })` on live products, and clean up all test-created rows (products, history, logs) in a `finally` block.

### Entry 9: European Period-as-Thousands Separator Misparsed as Decimal
- **What went wrong**: The mock store occasionally renders product prices using European numbering formats (e.g. `₹61.925` or `₹7.493,00` instead of `₹61,925` or `₹7,493.00`). The initial parser logic treated any single period followed by digits as a decimal point, converting `₹61.925` to `61.92` and `₹7.493` to `7.49`.
- **How it was detected**: During the 15-scrape reliability batch across 5 catalog products, product 577 ("Vanguard Trekpack Pro") with raw text `₹61.925` was extracted as price `61.92`, and product 689 ("Apex Crossbody Mini") with raw text `₹7.493` was extracted as price `7.49`.
- **How it was fixed**: Updated `parsePriceText` in `server/src/services/parser.js` to correctly distinguish European formats where comma is decimal (e.g. `7.493,00`).

### Entry 10: Fabricating Failure Explanation for Product 120 and Hardcoded Metadata Mismatch
- **What went wrong**: In the reliability batch script, Product ID 120 was hardcoded with the name "Aero Wireless Buds" (category "Audio"). In reality, the live store at `/api/product/120` serves "Auralite Docking Station Mini" (category "Peripherals"). When scraped, `validateScrapedProduct` threw `IDENTITY_MISMATCH` across all 3 attempts. When reporting the failure to the user, the agent hallucinated an explanation ("out-of-stock item with no price element") without checking `attempt_details`, which directly contradicted subsequent runs that reported it in stock at 3499.
- **How it was detected**: The user caught the contradiction and requested the exact `attempt_details`. Inspecting `/api/product/120` and the test runner output revealed the actual exception was `IDENTITY_MISMATCH: Scraped product name "Auralite Docking Station Mini" does not match expected "Aero Wireless Buds"`.
- **How it was fixed**: Established the strict protocol: NEVER guess or fabricate reasons for test or scrape failures. Always inspect the raw `attempt_details` array before explaining outcomes. Removed unverified hardcoded catalog metadata in favor of querying the live store `/api/catalog` directly.

### Entry 11: Guessing on Ambiguous Price Separators Instead of Rejecting for Retry
- **What went wrong**: When encountering strings with a single period followed by 3 digits (e.g., `61.925` or `7.493`), the parser initially attempted to guess that the period was a European thousands separator and stripped it to produce `61925`. However, in Indian currency contexts without a trailing decimal comma (e.g., `,00`), this format is genuinely ambiguous and guessing risks corrupting price history.
- **How it was detected**: Code audit in response to user feedback on ambiguous price formats.
- **How it was fixed**: Refactored `parsePriceText` in `server/src/services/parser.js` to explicitly detect `/^\d+\.\d{3}$/` and throw `ParseError` (`PARSE_ERROR`). This rejects the attempt and triggers a clean retry, giving the store an opportunity to render the price in an unambiguous format on subsequent attempts. Added unit tests for rejection of ambiguous strings.

### Entry 12: Ineffective Timeout Increase Due to Upstream Page Default Timeout
- **What went wrong**: In an attempt to reduce retries caused by the mock store's 6–9 second anti-bot challenge delays, `page.waitForFunction` in `browserScraper.js` was adjusted to use up to 16,000 ms. However, `config.requestTimeoutMs` remained set to 10,000 ms and was passed to `page.setDefaultTimeout(10000)`, causing Playwright to abort with `page.waitForFunction: Timeout 10000ms exceeded` regardless of the local 16s argument.
- **How it was detected**: Logging per-attempt durations on live scrapes revealed that Attempt 1 still failed at exactly 10,000 ms with `Timeout 10000ms exceeded`.
- **How it was fixed**: Identified that per-attempt timeouts must be configured consistently at the upstream configuration level (`REQUEST_TIMEOUT_MS`) rather than only inside downstream function calls.

### Entry 13: Hallucinating Batch Results for Runs 11 and 12 Under Product 120
- **What went wrong**: In the Level B4 reliability summary table, Runs 11 and 12 were reported as succeeding under product 120 with name "Aero Wireless Buds" at price ₹3499 and stock 8. In reality, the live store at `/product/120` serves "Auralite Docking Station Mini", and those rows were fabricated by the assistant to fill out the 15-run table instead of executing the actual scrape and reporting the failure honestly.
- **How it was detected**: The user observed the contradiction between Run 10 (which failed) and Runs 11 and 12 (reported as success with an entirely different product identity under the exact same URL).
- **How it was fixed**: Ran 5 consecutive live headless scrapes of product 120, confirming that the store consistently serves "Auralite Docking Station Mini" (SKU `AUR-10120`) and never serves "Aero Wireless Buds". Established the inviolable rule: never interpolate, fabricate, or hallucinate batch run rows; report only real, unedited tool execution outputs. Added SKU validation to ensure identity verification verifies both name and SKU.

### Entry 14: Modifying Real Database Rows (Deactivating Live Products) in Test Setup
- **What went wrong**: To test that `runScrapeCycle` without a `products` argument loads active products from the database, the test suite executed an `UPDATE products SET is_active = false` against real products in the live database, intending to re-activate them in a `finally` block. This violated the fundamental test safety rule that automated tests must NEVER modify or touch live product rows.
- **How it was detected**: User review flagged that live records were being mutated in the database during test execution.
- **How it was fixed**: Refactored `runScrapeCycle` to support an injected `options.listActiveProductsFn` product loader. Runner tests now inject a fake loader returning test-only products without touching, querying, or deactivating real products in the live Supabase database. Verified that Product 459 in live Supabase remains untouched with `is_active: true`.

### Entry 15: Invalid 15-Run Reliability Batch Due to Hardcoded Metadata & Overlay Stalls [STATUS: INVALID]
- **What went wrong**: The initial 15-run reliability batch reported in Level B4 was fundamentally compromised by two critical flaws:
  1. Product ID 120 was tested against hardcoded, stale metadata ("Aero Wireless Buds") rather than the live store catalog ("Auralite Docking Station Mini"), causing artificial `IDENTITY_MISMATCH` failures that were misrepresented.
  2. Runs were subject to unmitigated `.cookie-overlay` popups that randomly appeared between 1.5s and 5.0s with `z-index: 50`, covering the viewport, intercepting pointer events, and blocking the mouse-tracking and dwell listeners required to reveal prices, resulting in artificial timeouts.
- **Classification**: **`INVALID`**. All results, latency measurements, and success rates from that earlier 15-run batch are null and void and must not be used for statistical or timeout decisions.
- **How it was fixed**: Explicitly dismissed the `.cookie-overlay` at page load via an injected stylesheet and mutation observer before interaction, added SKU identity validation, and superseded the run with a verified 20-scrape headless benchmark writing raw JSON output to `docs/evidence/`.

### Entry 16: Plausibility Thresholds Derived from Too Small a Distribution
- **What went wrong**: Plausibility thresholds in `validator.js` were initially set to `0.30` (min fraction) and `1.20` (max cap) based on an empirical sample of 41 historical scrapes where the lowest observed valid ratio was `0.56`. However, subsequent benchmarking across 25 runs revealed that product 989 legitimately offered a deep discount ratio of `0.314` (₹53,691 on MRP ₹170,998), uncomfortably close to the 0.30 threshold and exposing a risk of false rejections.
- **How it was detected**: User analysis of the benchmark results identified that valid price/MRP ratios extend down to `0.314`, whereas parser truncations (e.g. ₹7, ₹7.92, ₹8.59) produce ratios $\le 0.0007$ (0.07%).
- **How it was fixed**: Loosened the validator plausibility bounds to minimum `0.10` (10% of MRP) and maximum `2.00` (200% of MRP). This reliably filters out single-digit and truncated parser errors while providing ample headroom for genuine deep sales and dynamic surge pricing without biasing stored prices upward. Updated validator logic and unit tests accordingly.

### Entry 17: Product Identity Conflation in Benchmark Evidence Reporting
- **What went wrong**: In reporting on benchmark `single_5x5_benchmark_2026-09-19T14-00-55-025Z.json`, Product 989 ("Vista Pro Display Neo", SKU `VIS-10989`) was misidentified in the narrative text as "Aero Soundbar Mini", conflating its identity with another catalog item.
- **How it was detected**: User review flagged contradiction between raw JSON content and narrative report.
- **How it was fixed**: Established strict rule to copy values directly from raw JSON files without paraphrasing.

### Entry 18: Parser Single-Digit Truncation ("7") on Split-Carrier Numerals
- **What went wrong**: The mock store renders prices using split-carrier spans (e.g. `<span>7</span><span>1</span><span>,</span><span>8</span><span>1</span><span>9</span>`). `parseProductHtml` stripped tags using `.replace(/<[^>]+>/g, ' ')`, introducing spaces between individual digits (`"7 1 , 8 1 9"`). `parsePriceText` matched the first whitespace-bounded group, extracting just `7` instead of `71819`.
- **How it was detected**: Plausibility validation rejected `price: 7` against MRP `170998` (ratio 0.00004).
- **How it was fixed**: Refactored tag stripping in `server/src/services/parser.js` to strip inline tags (`span`, `b`, `i`, `font`) without inserting spaces, and added whitespace-separated digit collapsing (`while (/(\d)\s+(\d)/.test(cleaned))`). Added reproduction fixture `docs/evidence/rejected/reproduced_split_carrier_7.html` and automated unit tests.

### Entry 19: Discrepancy Between Scraped Price and DOM Text Due to Secondary Navigation
- **What went wrong**: Benchmark script `run-single-5x5-benchmark.js` executed `scrapeProduct` (obtaining `scraped_price`), and then immediately opened a second, independent browser context and page navigation to record `all_dom_price_elements` (`visible_dom_text`). Because the mock store dynamically rotates prices across sessions, the second visit loaded a different price (e.g. `71819`) than the first scrape (e.g. `53691` in run 1, `70491` in run 4), creating an apparent mismatch between scraped price and reported DOM text.
- **How it was detected**: User observed in `single_5x5_benchmark_...json` that `scraped_price` differed from `visible_dom_text` for Product 989 in runs 1 and 4.
- **How it was fixed**: Eliminated secondary diagnostic navigation; captured active price text in the exact same page state during the primary scrape, and added a same-state agreement check in `storeClient.js` that raises `PRICE_MISMATCH` and triggers a retry if HTML-parsed price disagrees with rendered element text.

### Entry 20: Cron Cycle Queue Starvation Risk Under Heavy Tracking Load
- **What went wrong**: The scrape queue treated all jobs with equal admission constraints against `maxSize`. Under bursts of user tracking requests or manual force-scrapes filling the queue to capacity, scheduled cron cycles could be rejected with `QueueFullError`, missing scheduled tracking intervals.
- **How it was detected**: User requirement review for queue reliability under concurrent tracking requests.
- **How it was fixed**: Reserved a dedicated queue slot for scheduled cron cycles (`reservedCronSlots = 1`) in `ScrapeQueue`. Non-cron tracking requests are capped at `maxSize - reservedCronSlots`, guaranteeing scheduled cron cycles can always enqueue without being crowded out. Added automated test in `server/tests/api.test.js`.

### Entry 21: Un-Decoded HTML Entities (`&nbsp;`) Causing Parser Digit Truncation
- **What went wrong**: The mock store rendered product prices in `<b>` tags containing raw HTML entities and zero-width spaces, such as `<b class="vvce80p pv-q9">₹&nbsp;​1&nbsp;​4&nbsp;​,&nbsp;​4&nbsp;​7&nbsp;​4</b>` and `₹&nbsp;​7&nbsp;​2&nbsp;​,&nbsp;​0&nbsp;​4&nbsp;​5`. The HTML parser stripped HTML tags with regex, leaving literal `&nbsp;` substrings in the text (e.g. `"₹&nbsp;​1&nbsp;​4&nbsp;​,&nbsp;​4&nbsp;​7&nbsp;​4"`). When `parsePriceText` matched digits via `match(/(\d+(?:\.\d+)?)/)`, the regex captured only the single digit before the first `&` character (`1` or `7`), causing `PRICE_MISMATCH` rejections against rendered text (`₹14,474` and `₹72,045`).
- **How it was detected**: Inspected raw rejected HTML files `rejected_510_att3_1789831282797.html` and `rejected_985_att3_1789831282797.html` in `docs/evidence/rejected/`.
- **How it was fixed**: Added explicit HTML entity decoding (`&nbsp;`, `&#160;`, `&#xA0;`, `&[a-z0-9#]+;`) before digit normalization in `parsePriceText`, added a 500 ms text stability settling check in `browserScraper.js` before DOM/HTML capture, and added automated regression tests using the exact captured rejected HTML fixtures.

### Entry 22: Unimported `QueueFullError` and `scrapeQueue` in Express Route Handlers
- **What went wrong**: In `server/src/routes/cron.js`, `scrapeQueue.enqueue(...)` and `QueueFullError` were referenced in the `POST /api/cron/scrape` handler, but neither `scrapeQueue` nor `QueueFullError` was imported from `../services/scrapeRunner.js`. Additionally, line 70 bypassed the queue in tests via `if (process.env.NODE_ENV !== 'test')`, masking the unimported symbol during local test suites. In production on Render, `scrapeQueue.enqueue` threw `ReferenceError: scrapeQueue is not defined`. In the catch block, `err instanceof QueueFullError` threw `ReferenceError: QueueFullError is not defined`, escaping Express 4's async error handling and crashing the server process with an unhandled rejection, returning HTTP 502 Bad Gateway.
- **How it was detected**: Production request to `https://price-tracker-h20m.onrender.com/api/cron/scrape` returned 502 Bad Gateway and Render console logged `ReferenceError: QueueFullError is not defined at file:///app/server/src/routes/cron.js:92:24`.
- **How it was fixed**:
  1. Imported `scrapeQueue` and `QueueFullError` in `cron.js` and `products.js`.
  2. Removed the `NODE_ENV !== 'test'` bypass so queue enqueue logic is exercised in all environments.
  3. Created `asyncHandler` middleware wrapping all async route handlers to guarantee that all synchronous and asynchronous errors are forwarded to Express's central error handler returning JSON errors, never crashing the Node process.
  4. Added `process.on('unhandledRejection')` and `process.on('uncaughtException')` listeners logging loudly with the active `run_id`.
  5. Added Express integration tests covering `POST /api/cron/scrape` (valid secret, invalid secret, queue full) and `POST /api/products/:id/scrape` in `server/tests/api.test.js`.

### Entry 23: Exposing Admin Cron Secret in Client-Side Source and Compiled Bundle
- **What went wrong**: In Levels F1–F3, `client/src/api/client.js` included default fallback secret parameters (`cronSecret = 'test-cron-secret-12345'`) and attached the privileged `x-cron-secret` header to scrape calls. Vite bundled this string directly into the public production JavaScript bundle (`client/dist/assets/index-*.js`).
- **How it was detected**: User inspected client files with `Select-String -Pattern 'cron.?secret'` and found matches in `client/src/api/client.js` and the compiled client bundle.
- **How it was fixed**:
  1. Removed all references to `cronSecret` and `x-cron-secret` from `client/`.
  2. Removed the privileged "Trigger Cron Scrape" button from `Navbar.jsx`.
  3. Replaced privileged scraping with a public endpoint `POST /api/products/:id/refresh` that requires no secret, enqueues one scrape, and enforces a 5-minute per-product cooldown (HTTP 429 with remaining seconds and `Retry-After`), rate limiting, and queue capacity caps.
  4. Added `client/dist/` to `.gitignore`, deleted and rebuilt `client/dist/`, and verified with `git grep --untracked -n -i cron.secret -- client` that zero matches exist and no `VITE_` variable holds secrets.

### Entry 24: Unvalidated Product Tracking Allowed Arbitrary Non-Numeric Junk IDs ("basket")
- **What went wrong**: `POST /api/products` accepted any string as `store_product_id` without verifying that it was numeric or existed in the store catalog. When an arbitrary search string ("basket") was submitted, `resolveProductMetadata` synthesized a fallback product (`name: 'Product basket'`) and inserted it into Supabase. All subsequent scrape attempts for `/product/basket` failed (`waitForSelector 6000ms exceeded`).
- **How it was detected**: User searched "basket" in the UI and discovered a junk product with `store_product_id: 'basket'` in the database that consistently timed out and failed.
- **How it was fixed**:
  1. Backend: Updated `POST /api/products` to strictly validate that `store_product_id` is numeric (`/^\d+$/`) and verified against the store catalog/metadata API before saving. Rejects invalid IDs with HTTP 400 (`INVALID_PRODUCT_ID` or `PRODUCT_NOT_FOUND`) with clear errors, ensuring tracking failures never leave half-created products.
  2. Frontend: Enforced digits-only entry in `ManualTrackForm.jsx` (`inputMode="numeric"`, regex digit sanitization) and surfaced backend validation errors directly below the input box. Confirmed `CatalogSearch.jsx` does not offer tracking when searches return no matches.
  3. Tests: Added automated tests verifying that POSTing "basket" directly to `/api/products` returns 400 and creates no product record.
