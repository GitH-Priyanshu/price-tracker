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
