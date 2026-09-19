# Product Price Tracker

An automated price and stock tracking service and dashboard for e-commerce products, featuring resilient web scraping, real-time analytics, and honest execution telemetry.

---

## API Specification (Level B5)

All endpoints reside under the `/api` prefix and return JSON with standard HTTP status codes. Errors follow a consistent `{ "error": { "code": string, "message": string } }` envelope.

### Route Summary Table

| Method | Endpoint | Description | Auth / Security | Rate Limit |
|---|---|---|---|---|
| `GET` | `/api/health` | Liveness and uptime check (zero DB dependency) | Public | None |
| `GET` | `/api/search?q={query}` | Search upstream mock store catalog | Public | 60 req/min |
| `POST` | `/api/products` | Track a product by store ID or URL; triggers initial scrape | Public | None |
| `GET` | `/api/products` | List all active tracked products with latest price/stock | Public | None |
| `GET` | `/api/products/:id` | Get details and latest price for a single product | Public | None |
| `DELETE` | `/api/products/:id` | Soft-deactivate a tracked product | Public | None |
| `GET` | `/api/products/:id/history` | Historical price & stock points (`from`, `to`, `range`) | Public | None |
| `GET` | `/api/products/:id/logs` | Paginated scrape audit logs for a product | Public | None |
| `POST` | `/api/cron/scrape` | Trigger scheduled scrape cycle (async 202 or `?wait=true`) | `x-cron-secret` | 20 req/min |

---

### Endpoints & Curl Examples

#### 1. Liveness Health Check
```bash
curl -s http://localhost:3000/api/health
```
**Response (200 OK):**
```json
{
  "status": "ok",
  "timestamp": "2026-09-19T14:15:00.000Z",
  "uptime": 12.34
}
```

#### 2. Catalog Search
```bash
curl -s "http://localhost:3000/api/search?q=soundbar"
```
**Response (200 OK):**
```json
{
  "query": "soundbar",
  "count": 1,
  "products": [
    {
      "id": "510",
      "name": "Sonance Soundbar Pro",
      "category": "audio",
      "brand": "Sonance",
      "price": 61255,
      "mrp": 122510,
      "url": "https://demo.inelabteamdev.com/product/510"
    }
  ]
}
```

#### 3. Track New Product
Idempotent: if the product was previously tracked and deactivated, it will be reactivated. Triggers an immediate scrape cycle for initial data point.
```bash
curl -s -X POST http://localhost:3000/api/products \
  -H "Content-Type: application/json" \
  -d '{"store_product_id": "459"}'
```
**Response (201 Created):**
```json
{
  "product": {
    "id": "c1f7b0e2-63b0-4560-84cf-29b1dfadfe6a",
    "store_product_id": "459",
    "name": "Domus Sling Plus",
    "url": "https://demo.inelabteamdev.com/product/459",
    "is_active": true,
    "latest_price": {
      "price": 2899,
      "stock_status": "in_stock",
      "recorded_at": "2026-09-19T14:15:02.000Z"
    }
  }
}
```

#### 4. List Tracked Products
```bash
curl -s http://localhost:3000/api/products
```
**Response (200 OK):**
```json
{
  "count": 1,
  "products": [
    {
      "id": "c1f7b0e2-63b0-4560-84cf-29b1dfadfe6a",
      "store_product_id": "459",
      "name": "Domus Sling Plus",
      "last_scrape_status": "success",
      "last_scraped_at": "2026-09-19T14:15:02.000Z",
      "latest_price": {
        "price": 2899,
        "stock_status": "in_stock",
        "recorded_at": "2026-09-19T14:15:02.000Z"
      }
    }
  ]
}
```

#### 5. Get Single Product
```bash
curl -s http://localhost:3000/api/products/c1f7b0e2-63b0-4560-84cf-29b1dfadfe6a
```

#### 6. Deactivate Product
```bash
curl -s -X DELETE http://localhost:3000/api/products/c1f7b0e2-63b0-4560-84cf-29b1dfadfe6a
```
**Response (200 OK):**
```json
{
  "message": "Product deactivated successfully",
  "product": {
    "id": "c1f7b0e2-63b0-4560-84cf-29b1dfadfe6a",
    "is_active": false
  }
}
```

#### 7. Get Price & Stock History
Supports `range=24h`, `range=7d`, `range=30d`, or custom ISO strings `from` and `to`.
```bash
curl -s "http://localhost:3000/api/products/c1f7b0e2-63b0-4560-84cf-29b1dfadfe6a/history?range=7d"
```
**Response (200 OK):**
```json
{
  "product_id": "c1f7b0e2-63b0-4560-84cf-29b1dfadfe6a",
  "count": 2,
  "history": [
    {
      "id": "50",
      "price": 2899,
      "stock_status": "in_stock",
      "stock_quantity": 14,
      "recorded_at": "2026-09-19T14:15:02.000Z"
    }
  ]
}
```

#### 8. Get Product Scrape Logs
Supports pagination via `limit` (default 50) and `offset` (default 0).
```bash
curl -s "http://localhost:3000/api/products/c1f7b0e2-63b0-4560-84cf-29b1dfadfe6a/logs?limit=10"
```
**Response (200 OK):**
```json
{
  "product_id": "c1f7b0e2-63b0-4560-84cf-29b1dfadfe6a",
  "count": 2,
  "limit": 10,
  "offset": 0,
  "logs": [
    {
      "id": "55",
      "status": "success",
      "attempts": 1,
      "duration_ms": 3812,
      "http_status": 200,
      "created_at": "2026-09-19T14:15:02.000Z"
    }
  ]
}
```

#### 9. Scheduled Scrape Cycle (Cron Endpoint)
Protected by `x-cron-secret` via constant-time comparison. Returns `202 Accepted` immediately with a `run_id` to prevent gateway timeouts.
```bash
curl -s -X POST http://localhost:3000/api/cron/scrape \
  -H "x-cron-secret: your-cron-secret"
```
**Response (202 Accepted):**
```json
{
  "status": "accepted",
  "message": "Scrape cycle accepted and running in background",
  "run_id": "e2f074d2-f67b-402a-9e19-9154a4f8953f"
}
```
```bash
curl -s -X POST "http://localhost:3000/api/cron/scrape?wait=true" \
  -H "x-cron-secret: your-cron-secret"
```

---

## Headed Observable Scraper & Screen Recording (Level B6)

Level B6 introduces an observable, headed scraping mode allowing developers and evaluators to watch the scraper navigate the mock store, dismiss cookie banners, interact with anti-bot elements, visually highlight resolved price elements, and observe retry and failure mechanics in real time.

### CLI Command & npm Script
Run from repository root or the `server/` workspace:
```bash
npm run scrape:watch -- [productId] [flags]
# Or directly with node:
node server/scripts/scrape-once.js [productId] [flags]
```

### Supported Flags
| Flag | Description |
|---|---|
| `<productId>` | Target product store ID (defaults to `459` — Domus Sling Plus) |
| `--headed` | Launches visible Chromium browser window with live interaction (default) |
| `--headless` | Runs in headless mode (useful for CI/automated checks) |
| `--no-db` | Dry-run mode: skips writing price history to Supabase database |
| `--simulate-slow` | Demo fault injection: forces Attempt 1 to stall and timeout, followed by successful retry |
| `--simulate-failure` | Demo fault injection: forces upstream outage (503), demonstrating retry exhaustion and DB write rejection |
| `--demo-all` | Runs all 3 demonstration scenarios sequentially for an automated 2–3 minute screen recording |

> [!IMPORTANT]
> **Production Security Guard**: The fault injection flags (`--simulate-slow`, `--simulate-failure`, `--demo-all`) can only be invoked via CLI in development/test environments. They are strictly rejected when `NODE_ENV === 'production'`, and cannot be triggered via HTTP API endpoints, cron query parameters, request bodies, or environment variables.

---

### Suggested 2-to-4 Minute Screen Recording Script

#### Option A: One-Command Automated Sequence (Recommended)
Run all three scenarios back-to-back:
```bash
npm run scrape:watch -- 459 --demo-all
```
This runs:
1. **Scenario 1 (Normal Scrape)**: Opens visible browser, dismisses cookie banner, hovers over `.price-block`, clicks reveal button, highlights resolved price with green outline, and logs successful attempt timeline.
2. **Scenario 2 (Stalled Attempt & Retry)**: Injects slow dwell stall, triggers Playwright timeout on Attempt 1, applies backoff, and automatically recovers on Attempt 2.
3. **Scenario 3 (Simulated Failure)**: Injects upstream outage across all attempts, shows retry exhaustion, logs honest failure telemetry, and deliberately skips database writes to preserve data integrity.

#### Option B: Individual Interactive Commands
```bash
# 1. Normal observable scrape
npm run scrape:watch -- 459 --no-db

# 2. Slow challenge stall with retry recovery
npm run scrape:watch -- 459 --no-db --simulate-slow

# 3. Upstream outage with zero DB pollution
npm run scrape:watch -- 459 --no-db --simulate-failure
```

