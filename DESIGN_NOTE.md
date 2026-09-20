# Engineering Design Note: Price Tracker

**Author**: Priyanshu  
**System**: Production Automated E-Commerce Price Tracker  
**Date**: September 2026  

---

## 1. Reliability Techniques & Architecture

When building an automated price-tracking service against an e-commerce store with aggressive anti-scraping protections, reliability cannot be an afterthought. I designed the architecture around several hard operational constraints:

1. **FIFO Serialized Queue (`concurrency: 1`)**:
   Instead of launching concurrent browser tabs that spike server memory and trigger rate-limiting, all scraping operations are queued in FIFO order and processed sequentially. The queue enforces a strict capacity limit of 10 jobs with 1 permanently reserved slot for scheduled cron cycles, preventing user on-demand refreshes from starving scheduled tracking.
2. **Zero DB Pollution on Scrape Failures**:
   A scrape attempt that fails validation, times out, or encounters an upstream 503 error is recorded in `scrape_logs` for honest auditability, but **never** writes to `price_history`. Failed attempts never write zero, null, or speculative prices into historical charts.
3. **Same-State Active Price Agreement Check**:
   To prevent split-carrier or layout rendering artifacts from corrupting records, the pipeline extracts the active price from the DOM and immediately cross-checks it against the rendered text of the active price container in the exact same page state. If there is any disagreement, the attempt is rejected as `PRICE_MISMATCH` and retried with backoff.
4. **Plausibility Bounds**:
   Extracted prices are compared against the product MRP. If the extracted price falls below 10% or exceeds 200% of the MRP, the attempt is rejected as a plausibility failure. This prevents truncated single-digit extraction bugs from ever entering the database.
5. **Honest Cache with On-Demand Fallback**:
   The upstream catalog API randomly shuffles items across paginated slices. Rather than pretending a 20-page crawl is complete when only ~635 unique items were discovered out of 1000, the cache honestly marks `isPartial: true`. When a user searches for an item omitted by the shuffle, the engine automatically falls back to a direct numeric lookup against `GET /api/product/:id`.

---

## 2. Why a Headless Browser Was Strictly Required

During preliminary reconnaissance (documented in `docs/STORE_ANALYSIS.md`), I evaluated whether a lightweight HTTP parser (such as Cheerio or Axios) or direct API consumption could be used instead of a headless browser. The empirical evidence proved that a real browser engine is non-negotiable:

1. **Blank Static HTML (SPA Shell)**:
   The raw response returned by `GET https://demo.inelabteamdev.com/product/:id` is an empty Vite/React shell containing only `<div id="root"></div>`. No product names, prices, or stock counts exist in the server-delivered HTML.
2. **Excluded Price & Encrypted Challenge**:
   The store's public REST APIs (`/api/catalog`, `/api/product/:id`) only return static metadata (name, brand, category, sku, specs). Price and stock are excluded. Fetching prices via HTTP requires calling an obfuscated WebAssembly anti-bot endpoint (`/api/challenge`) that verifies canvas/WebGL hardware fingerprints, tracks mouse movement coordinates, and XOR-decrypts a payload with a short-lived token. Re-implementing this client-side anti-bot routine in Node.js would be fragile and break on layout revisions [CHECK: exact challenge crypto rotation schedule].
3. **Interactive Human Dwell & Mouse Tracking**:
   The store instantiates an interaction guard: `new Ar({ minMoves: 8, minDwellMs: 600 })`. The price block displays `"Price hidden"` until the cursor enters `.price-block`, executes at least 8 distinct coordinate moves, dwells for $\ge 600\text{ms}$, and clicks the `"Reveal price"` button.
4. **Honey-Pot Decoy Price Elements**:
   The DOM includes hidden decoy elements (`display: none`, `aria-hidden="true"`) containing falsified prices (e.g. ₹7,854 vs real ₹6,727). A real browser context is required to evaluate computed visibility styles and ignore decoy traps.

---

## 3. Key Trade-offs

- **Playwright Headless Browser vs. Memory Footprint**:
  Chromium uses ~120–160MB of RAM per instance and takes 2–5 seconds per scrape compared to ~10ms for raw HTTP requests. I accepted this overhead because it provides 100% extraction accuracy against the client-side challenge. Running with `concurrency: 1` ensures memory stays well within Render's 512MB free-tier limit.
- **In-Memory Catalog Cache vs. Live Catalog Crawls**:
  Crawling all 20 pages of the store catalog takes ~6–8 seconds under rate-limiting. Caching the deduplicated catalog in memory with a 30-minute TTL gives sub-millisecond search performance, while degraded 60-second TTLs are applied if upstream rate limits cause missing pages.
- **Strict Validation vs. Missing Data**:
  If a price format is ambiguous (e.g. European period notation `₹61.925` without a decimal comma), the parser rejects the attempt rather than guessing. This trade-off prioritizes data integrity over immediate success, allowing a subsequent retry to capture unambiguous formatting.

---

## 4. What the AI Tools Got Wrong and How It Was Corrected

Building this system in pair programming with AI tools revealed several systematic failure patterns that required human verification, code audits, and strict constraints:

1. **Hallucinating Batch Results & Explanations**:
   When Product 120 failed identity validation due to a hardcoded name mismatch, the AI tool fabricated an explanation ("out-of-stock item with no price element") without checking `attempt_details`. In later benchmarks, it hallucinated success rows for runs it never executed.  
   *Correction*: Established the inviolable rule: never interpolate or guess failure causes. Scrape outcomes must be reported solely from real tool execution output and raw `attempt_details`.
2. **Mutating Live Database Records in Tests**:
   To test product loading logic, the AI tool generated tests that ran `UPDATE products SET is_active = false` against real user products in the production Supabase database.  
   *Correction*: Refactored `runScrapeCycle` to support dependency-injected product loaders and created strict test-token guards that throw `[SAFETY GUARD VIOLATION]` if any non-test product is touched.
3. **Split-Carrier Single-Digit Truncation ("7")**:
   When the store rendered prices inside split-carrier spans (e.g. `<span>7</span><span>1</span><span>,</span><span>8</span><span>1</span><span>9</span>`), the AI parser stripped tags with spaces, converting the text to `"7 1 , 8 1 9"` and extracting only the single digit `7`.  
   *Correction*: Implemented space-free inline tag stripping, whitespace digit collapsing, and MRP plausibility bounds (10% to 200%) to catch and reject any truncated numbers.
4. **Unsupported Chromium Flags (`--single-process`)**:
   The AI tool introduced `--single-process` into Chromium launch arguments, which caused abrupt tab crashes on Windows and Playwright context disposal errors.  
   *Correction*: Removed `--single-process` and pinned Playwright to identical versions across Dockerfile and `package.json`.
5. **Trailing Slashes Breaking Production CORS**:
   Configuring `FRONTEND_ORIGIN=https://my-app.vercel.app/` with a trailing slash broke CORS comparisons because browser `Origin` headers never include trailing slashes.  
   *Correction*: Built `normalizeOrigin()` on the server to trim whitespace and strip trailing slashes from both configured and incoming origins before comparison.
6. **Incomplete Catalog Page Assumptions (20 × 20 ≠ 1000)**:
   The AI tool assumed 20 pages at the default page size of 20 fetched the entire 1000-item catalog, silently omitting 600 products ($20 \times 20 = 400$).  
   *Correction*: Rebuilt catalog cache crawling with `pageSize=50` across all 20 pages with controlled concurrency (4 workers), retries, and direct lookup fallback.
