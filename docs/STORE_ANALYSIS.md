# Mock Store Reconnaissance & Technical Analysis

**Target Store**: `https://demo.inelabteamdev.com/`  
**Date of Analysis**: September 19, 2026  
**Investigated By**: Antigravity Pair Programming Agent  

---

## 1. Executive Summary & Scraping Approach Decision

### **Decision: Playwright Headless Browser (Required)**

| Approach | Feasible? | Reliability | Evidence & Rationale |
| :--- | :---: | :---: | :--- |
| **Plain HTTP + HTML Parsing (Cheerio)** | ❌ **No** | 0% | The served HTML is a completely blank Single Page Application (`<div id="root"></div>`) rendered entirely client-side via React. Price and stock are **never** present in the initial static HTML. |
| **Direct Underlying JSON API** | ❌ **No** | Infeasible / Brittle | While public REST endpoints `/api/catalog` and `/api/product/:id` exist, they **only** return static product metadata (id, name, brand, category, description, specs). Price and stock are excluded. Fetching price requires calling an obfuscated, anti-bot WebAssembly challenge (`/api/challenge`) requiring real browser canvas/webgl fingerprints and human mouse-movement tracking (`minMoves: 8`, `minDwellMs: 600`), followed by XOR-decrypting an encrypted payload with a short-lived token. Re-implementing this client-side anti-bot system in raw Node.js is fragile and liable to break on layout rotations. |
| **Playwright (Headless Chromium)** | ✅ **Yes** | 100% | Playwright executes the client application, satisfies the dwell/mouse requirement over the price area, dismisses cookie overlays, triggers the price reveal interaction, waits for asynchronous resolution, and extracts visible price and stock while ignoring decoy elements. |

**Verdict**: The mock store was deliberately designed with client-side anti-scraping defenses that genuinely necessitate a headless browser. Playwright is strictly justified based on hard empirical evidence.

---

## 2. Store Architecture & Network Mechanics

### A. Initial HTML vs. Rendered DOM
- **Raw HTML Served**: A minimalist Vite/React shell:
  ```html
  <!doctype html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
      <title>INE Store</title>
      <script type="module" crossorigin src="/assets/index-B9UiQq4X.js"></script>
      <link rel="stylesheet" crossorigin href="/assets/index-DrctpSuy.css">
    </head>
    <body>
      <div id="root"></div>
    </body>
  </html>
  ```
- **Rendered DOM**: React mounts the full store UI into `#root`, complete with navigation, breadcrumbs, search input, catalog filters, and product details.

### B. Network API Endpoints
Reverse-engineering of the frontend bundle (`index-B9UiQq4X.js`) reveals three public endpoints:
1. `GET /api/catalog?page=${page}&pageSize=${pageSize}`
   - Returns paginated catalog items: `{ page, pageSize, pages, total: 1000, items: [...] }`.
   - Each item includes: `id` (integer, e.g. `459`), `slug` (string, e.g. `"domus-sling-plus"`), `name`, `brand`, `category`, `sku`, `description`.
   - **Critical Finding**: Query parameters such as `?q=`, `?search=`, `?query=`, `?name=` are ignored by the backend API. It always returns all 1000 items page by page.
2. `GET /api/product/${id}`
   - Accepts numeric ID (e.g. `459`). Returns product metadata and specs.
   - **Crucial**: Does NOT accept slugs (returns 404), and does NOT contain price or stock.
3. `GET /api/layout`
   - Returns dynamic layout configuration and rotated class prefixes:
     ```json
     {
       "revision": 626001,
       "variant": 3,
       "classes": {
         "priceWrap": "pw-m4",
         "priceValue": "pv-m4",
         "mrp": "mr-m4",
         "sale": "sl-m4",
         "badge": "bd-m4",
         "rating": "rt-m4",
         "seller": "sr-m4",
         "delivery": "dl-m4",
         "stock": "st-m4"
       },
       "order": ["delivery", "rating", "stock", "seller"],
       "priceTag": "output"
     }
     ```
   - Notice that the price tag element (`priceTag`) rotates (e.g., `output`, `span`) and CSS classes rotate periodically.

---

## 3. The Price & Stock Interaction Mechanics

When a product detail page (e.g., `https://demo.inelabteamdev.com/product/459`) is opened:
1. **Initial Unrevealed State**:
   - The price block displays `"Price hidden"`.
   - Substatus message: `"Hover over the price area to load the current price."`
   - A `"Reveal price"` button is present (`button[aria-label="Reveal price"]`).
2. **Interaction Challenge**:
   - The store bundle instantiates a tracker: `new Ar({ minMoves: 8, minDwellMs: 600 })`.
   - The `"Reveal price"` button is disabled until the pointer enters `.price-block`, executes at least 8 distinct coordinate movements, and dwells for at least 600 milliseconds.
   - If clicked prematurely or without mouse movement, the interaction does not proceed.
3. **Transient Loading State**:
   - Once revealed, the phase shifts to `loading` / `retrying`, showing:
     - `"Loading current price…"`
     - `"Retrying (attempt X/6)…"`
     - Or a momentary `"Updating…"` banner.
4. **Resolved State**:
   - The real price is injected into the DOM container `.price-main`.
   - Stock status is rendered inside `.stock-badge` with classes `in-stock` or `out-stock`.

---

## 4. Deliberate Awkward Behaviors & Honey-Pot Traps

Our deep inspection uncovered multiple intentional hurdles designed to break naive scrapers:

### A. Decoy / Honey-Pot Price Elements
Inside `.price-main`, the mock store injects decoy hidden price elements:
```html
<span class="price-value" aria-hidden="true" style="display: none;">₹7,854</span>
<span class="amount" data-price="true" aria-hidden="true" style="display: none;">₹4,040</span>
```
- A scraper relying on `.price-value` or `[data-price="true"]` will scrape **completely fabricated, stale prices**.
- **Defense**: We must verify element visibility (`style.display !== 'none'` and `aria-hidden !== 'true'`) or target the specific unhidden tag (`output` or `span` matching layout/unhidden criteria) while explicitly rejecting elements with strikethrough MRP styling (`mr-*`).

### B. Obfuscated Formatting Variations
The price string formatter `Ir()` randomly applies one of multiple formatting permutations:
- `spaced`: `₹ 6 727` (spaces as thousands separators).
- `euro`: `6.727,00` (periods as thousands separators, comma decimal).
- `trailing`: `₹6,727/- (incl. of all taxes)`.
- `unicode`: Full-width digits (e.g., `６７２７` using code points 65296+).
- `nbsp`: Digits interspersed with `\xA0` (non-breaking space) and `\u200B` (zero-width space) between every character!
- `lakh`: `Rs. 6,727.00`.
- **Defense**: Robust parser must normalize unicode digits, strip zero-width characters (`\u200b`), non-breaking spaces (`\u00a0`), currency symbols (`₹`, `Rs.`, `INR`), handle both `,` and `.` decimal formats, and validate that `price > 0`.

### C. Dynamic Stock Status Phrasing
Stock status is rendered inside `.stock-badge` with rotating copy:
- `"In stock · 100 left"`
- `"Only 100 left"`
- `"100 in stock"`
- `"Selling fast — 100 left"`
- `"Hurry, just 100 left"`
- `"Out of stock"`
- **Defense**: Normalize stock to fixed enum values: `'in_stock'` vs `'out_of_stock'`, and extract the integer quantity if available.

### D. Cookie Consent Interceptor
On initial visit, a cookie modal (`.cookie-consent`) may overlay the viewport.
- **Defense**: The browser scraper must check for and dismiss the consent banner immediately upon navigation.

---

## 5. Product Identification & Search Strategy

1. **Product Identification**:
   - Primary Unique Key: `store_product_id` (numeric string, e.g. `"459"`).
   - Secondary Slug: `"domus-sling-plus"` (used in frontend URLs: `/product/459` or `/product/domus-sling-plus`).
   - Note: The URL `/product/459` reliably loads the product.
2. **Search Strategy**:
   - Since `/api/catalog` does not accept search filters on the server, the scraper backend will implement `searchProducts(query)` by fetching catalog pages, caching catalog entries in memory with a short TTL (10 minutes), and filtering server-side by case-insensitive partial match on `name`, `category`, or `brand`.

---

## 6. Fixtures Captured (`/server/tests/fixtures`)

The following authentic fixture snapshots have been captured:
1. `catalog_page_1.json`: Raw response of 20 catalog products from `/api/catalog?page=1&pageSize=20`.
2. `product_459_metadata.json`: Raw metadata for product 459 from `/api/product/459`.
3. `layout.json`: Dynamic layout configuration from `/api/layout`.
4. `product_loading_placeholder.html`: Rendered DOM during "Price hidden" / "Hover over price" state.
5. `product_normal_revealed.html`: Rendered DOM with revealed real price and stock badge.
6. `product_error_page.html`: Rendered DOM when product ID does not exist (404).
7. `product_structure_shift.html`: Synthetic mutation testing missing or altered DOM elements.

---

## 7. Price Plausibility Validation Rules

To protect the historical database from corrupted prices caused by DOM element shifts, partial string slicing, or spaced thousands (e.g. `₹7 921` parsed as `7`), the validator enforces an evidence-based MRP plausibility check whenever an MRP badge is present:

- **Minimum Plausibility Ratio**: `0.10` (Price must be at least 10% of MRP).
  - *Evidence*: Legitimate heavy sales discounts in benchmark reached `0.314` (e.g. Product 989: ₹53,691 on ₹170,998 MRP). Truncation parser errors produced ratios <= `0.001` (e.g. ₹7 on ₹170,998). The `0.10` floor prevents parser errors while guaranteeing deep discounts are not rejected.
- **Maximum Plausibility Ratio**: `2.00` (Price cannot exceed 200% of MRP).
  - *Evidence*: Accommodates dynamic surge pricing without accepting corrupted multi-order-of-magnitude values.
- **Absence of MRP**: When no MRP element exists on the page, the ratio check is skipped gracefully without rejecting the scrape.

