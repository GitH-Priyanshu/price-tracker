process.env.NODE_ENV = 'test';

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import app from '../src/index.js';
import config, { normalizeOrigin } from '../src/config/index.js';
import { createRateLimiter } from '../src/middleware/rateLimiter.js';
import { getSupabaseClient } from '../src/db/client.js';
import scrapeQueue, { QueueFullError } from '../src/services/scrapeQueue.js';
import { clearRefreshCooldowns } from '../src/routes/products.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let server = null;
let baseUrl = '';

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  scrapeQueue.clear();
  try {
    const { closeBrowser } = await import('../src/services/browserScraper.js');
    await closeBrowser();
  } catch (e) {}
  // Safety cleanup: ensure no test-* products remain in DB
  const supabase = getSupabaseClient();
  const { data: testProducts } = await supabase
    .from('products')
    .select('id')
    .like('store_product_id', 'test-%');
  if (testProducts && testProducts.length > 0) {
    for (const p of testProducts) {
      await supabase.from('scrape_logs').delete().eq('product_id', p.id);
      await supabase.from('price_history').delete().eq('product_id', p.id);
      await supabase.from('products').delete().eq('id', p.id);
    }
  }
});

test('Level B5: Health Endpoint', async (t) => {
  await t.test('GET /api/health returns 200 with status ok and uptime', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.ok(body.timestamp);
    assert.ok(typeof body.uptime === 'number');
  });
});

test('Level B5: Security & CORS Normalization', async (t) => {
  await t.test('normalizeOrigin trims whitespace and strips trailing slashes', () => {
    assert.equal(normalizeOrigin('https://price-tracker-client.vercel.app/'), 'https://price-tracker-client.vercel.app');
    assert.equal(normalizeOrigin('  https://price-tracker-client.vercel.app/  '), 'https://price-tracker-client.vercel.app');
    assert.equal(normalizeOrigin('http://localhost:5173/'), 'http://localhost:5173');
    assert.equal(normalizeOrigin('*'), '*');
    assert.equal(normalizeOrigin(''), '');
    assert.equal(normalizeOrigin(null), '');
  });

  await t.test('CORS headers allow requests from normalized frontend origin', async () => {
    const res = await fetch(`${baseUrl}/api/health`, {
      headers: { Origin: 'http://localhost:5173' }
    });
    assert.equal(res.status, 200);
    const allowOrigin = res.headers.get('access-control-allow-origin');
    assert.ok(allowOrigin === 'http://localhost:5173' || allowOrigin === '*');
  });
});

test('Level B5: Search Route (/api/search)', async (t) => {
  await t.test('rejects missing "q" parameter with 400 INVALID_QUERY', async () => {
    const res = await fetch(`${baseUrl}/api/search`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error?.code, 'INVALID_QUERY');
    assert.match(body.error?.message, /at least 2 characters/);
  });

  await t.test('rejects "q" shorter than 2 characters with 400 INVALID_QUERY', async () => {
    const res = await fetch(`${baseUrl}/api/search?q=a`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error?.code, 'INVALID_QUERY');
  });

  await t.test('returns 200 and matches catalog items for valid query', async () => {
    const res = await fetch(`${baseUrl}/api/search?q=monitor`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.query, 'monitor');
    assert.ok(Array.isArray(body.products));
    assert.equal(typeof body.count, 'number');
  });

  await t.test('search for "domus" returns items with store_product_id and includes "Domus Sling Plus" (459)', async () => {
    const res = await fetch(`${baseUrl}/api/search?q=domus`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.products));
    assert.ok(body.products.length > 0);

    // Verify store_product_id is populated on every result
    for (const item of body.products) {
      assert.ok(item.store_product_id, `store_product_id should be present, got ${item.store_product_id}`);
      assert.equal(typeof item.store_product_id, 'string');
    }

    // Verify Domus Sling Plus (459) is present in the results
    const domus459 = body.products.find((p) => String(p.store_product_id) === '459');
    assert.ok(domus459, 'Search for domus must return Domus Sling Plus (id 459)');
    assert.equal(domus459.name, 'Domus Sling Plus');
  });

  await t.test('multi-word and case-insensitive matching on fixture: "domus", "sling", "domus sling", "domus sling plus" all return 459', async () => {
    // Fixture with product 459 and several other "domus" and sling products
    const fixture = [
      { id: 459, name: 'Domus Sling Plus', brand: 'Domus', sku: 'DOM-10459', category: 'Bags' },
      { id: 697, name: 'Domus Backpack S', brand: 'Domus', sku: 'DOM-10697', category: 'Bags' },
      { id: 101, name: 'Domus Sleeve Air', brand: 'Domus', sku: 'DOM-10101', category: 'Bags' },
      { id: 303, name: 'Domus Workstation Three', brand: 'Domus', sku: 'DOM-10303', category: 'Desks' },
      { id: 202, name: 'Summit Sling Lite', brand: 'Summit', sku: 'SUM-10202', category: 'Bags' }
    ];

    function filterFixture(query) {
      const norm = query.trim().toLowerCase();
      const words = norm.split(/\s+/).filter(Boolean);
      const matched = fixture.filter((it) => {
        const text = `${it.name} ${it.brand} ${it.sku}`.toLowerCase();
        return words.every((w) => text.includes(w));
      });
      matched.sort((a, b) => {
        const aExact = a.name.toLowerCase() === norm ? 0 : 1;
        const bExact = b.name.toLowerCase() === norm ? 0 : 1;
        if (aExact !== bExact) return aExact - bExact;
        return a.name.localeCompare(b.name);
      });
      return matched;
    }

    const q1 = filterFixture('domus');
    assert.ok(q1.some((it) => it.id === 459), 'fixture search "domus" must return 459');

    const q2 = filterFixture('sling');
    assert.ok(q2.some((it) => it.id === 459), 'fixture search "sling" must return 459');

    const q3 = filterFixture('domus sling');
    assert.ok(q3.some((it) => it.id === 459), 'fixture search "domus sling" must return 459');

    const q4 = filterFixture('domus sling plus');
    assert.ok(q4.some((it) => it.id === 459), 'fixture search "domus sling plus" must return 459');
    assert.equal(q4[0].id, 459, 'exact name match must be ordered first');
  });

  await t.test('live search endpoint: "domus", "sling", "domus sling", "domus sling plus" all return Domus Sling Plus (459)', async () => {
    const queries = ['domus', 'sling', 'domus sling', 'domus sling plus'];
    for (const q of queries) {
      const res = await fetch(`${baseUrl}/api/search?q=${encodeURIComponent(q)}`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(Array.isArray(data.products), `products must be array for q="${q}"`);
      const item459 = data.products.find((p) => String(p.store_product_id) === '459');
      assert.ok(item459, `Search for "${q}" must return Domus Sling Plus (459)`);
      assert.equal(item459.name, 'Domus Sling Plus');
    }
  });

  await t.test('GET /api/search/stats returns cache details and verifies 459 is present', async () => {
    const res = await fetch(`${baseUrl}/api/search/stats`);
    assert.equal(res.status, 200);
    const stats = await res.json();
    assert.equal(stats.has459, true, 'has459 should be true in cache stats');
    assert.ok(stats.itemCount > 0, 'itemCount should be positive');
  });

  await t.test('search with numeric ID falls back to direct store lookup if absent in cache', async () => {
    const res = await fetch(`${baseUrl}/api/search?q=459`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.products));
    const found = data.products.find((p) => String(p.store_product_id) === '459');
    assert.ok(found, 'Direct numeric lookup must find product 459');
    assert.equal(found.name, 'Domus Sling Plus');
  });

  await t.test('Track button posts store_product_id from search result and creates product with correct id and name', async () => {
    // Search catalog for a known item
    const searchRes = await fetch(`${baseUrl}/api/search?q=domus`);
    const searchBody = await searchRes.json();
    const resultItem = searchBody.products.find((p) => String(p.store_product_id) === '459');
    assert.ok(resultItem, 'Found product in search');

    // Simulate clicking Track on the search result
    const trackRes = await fetch(`${baseUrl}/api/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        store_product_id: resultItem.store_product_id,
        name: resultItem.name,
        category: resultItem.category,
        brand: resultItem.brand,
        sku: resultItem.sku
      })
    });

    // 201 Created (or idempotent response)
    assert.ok(trackRes.status === 201 || trackRes.status === 200);
    const trackBody = await trackRes.json();
    assert.equal(String(trackBody.product.store_product_id), '459');
    assert.equal(trackBody.product.name, 'Domus Sling Plus');
  });
});

test('Level B5: Cron Endpoint Security & Execution (/api/cron/scrape)', async (t) => {
  await t.test('rejects request without x-cron-secret header with 401 UNAUTHORIZED', async () => {
    const res = await fetch(`${baseUrl}/api/cron/scrape`, { method: 'POST' });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error?.code, 'UNAUTHORIZED');
    assert.match(body.error?.message, /missing x-cron-secret/);
  });

  await t.test('rejects request with invalid secret with 401 UNAUTHORIZED', async () => {
    const res = await fetch(`${baseUrl}/api/cron/scrape`, {
      method: 'POST',
      headers: { 'x-cron-secret': 'wrong-secret-token' }
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error?.code, 'UNAUTHORIZED');
  });

  await t.test('responds immediately with 202 and run_id when valid secret provided', async () => {
    const res = await fetch(`${baseUrl}/api/cron/scrape`, {
      method: 'POST',
      headers: { 'x-cron-secret': config.cronSecret }
    });
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.status, 'accepted');
    assert.ok(body.run_id);
  });
});

test('Level B5: Products API Routes (/api/products)', async (t) => {
  await t.test('GET /api/products returns 200 with array of products', async () => {
    const res = await fetch(`${baseUrl}/api/products`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.products));
    assert.equal(typeof body.count, 'number');
  });

  await t.test('POST /api/products rejects missing identifier with 400 INVALID_INPUT', async () => {
    const res = await fetch(`${baseUrl}/api/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error?.code, 'INVALID_INPUT');
  });

  await t.test('POST /api/products rejects non-numeric store_product_id ("basket") with 400 INVALID_PRODUCT_ID', async () => {
    const res = await fetch(`${baseUrl}/api/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ store_product_id: 'basket' })
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error?.code, 'INVALID_PRODUCT_ID');
    assert.match(body.error?.message, /must be numeric/i);
  });

  await t.test('POST /api/products rejects URL with non-numeric product ID with 400', async () => {
    const res = await fetch(`${baseUrl}/api/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://demo.inelabteamdev.com/product/basket' })
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error?.code, 'INVALID_PRODUCT_ID');
  });

  await t.test('POST /api/products rejects non-existent product ID with 400 PRODUCT_NOT_FOUND without leaving half-created product', async () => {
    const junkId = '99999999';
    const res = await fetch(`${baseUrl}/api/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ store_product_id: junkId })
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error?.code, 'PRODUCT_NOT_FOUND');
    assert.match(body.error?.message, /does not exist in store catalog/i);

    // Verify no half-created product record exists in Supabase
    const supabase = getSupabaseClient();
    const { data } = await supabase.from('products').select('*').eq('store_product_id', junkId);
    assert.equal((data || []).length, 0);
  });

  await t.test('GET /api/products/:id returns 404 NOT_FOUND for non-existent id', async () => {
    const res = await fetch(`${baseUrl}/api/products/00000000-0000-0000-0000-000000000000`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error?.code, 'NOT_FOUND');
  });

  await t.test('DELETE /api/products/:id returns 404 NOT_FOUND for non-existent id', async () => {
    const res = await fetch(`${baseUrl}/api/products/00000000-0000-0000-0000-000000000000`, {
      method: 'DELETE'
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error?.code, 'NOT_FOUND');
  });

  await t.test('GET /api/products/:id/history returns 404 for non-existent id', async () => {
    const res = await fetch(`${baseUrl}/api/products/00000000-0000-0000-0000-000000000000/history`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error?.code, 'NOT_FOUND');
  });

  await t.test('GET /api/products/:id/logs returns 404 for non-existent id', async () => {
    const res = await fetch(`${baseUrl}/api/products/00000000-0000-0000-0000-000000000000/logs`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error?.code, 'NOT_FOUND');
  });
});

test('Level B5: Security & Error Handling', async (t) => {
  await t.test('central 404 handler returns consistent { error: { code, message } } format', async () => {
    const res = await fetch(`${baseUrl}/api/non-existent-endpoint`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error?.code, 'NOT_FOUND');
    assert.match(body.error?.message, /Route GET \/api\/non-existent-endpoint not found/);
  });

  await t.test('CORS headers allow frontend origin and x-cron-secret header', async () => {
    const res = await fetch(`${baseUrl}/api/health`, {
      method: 'OPTIONS',
      headers: {
        'Origin': config.frontendOrigin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'x-cron-secret,Content-Type'
      }
    });
    assert.ok(res.headers.get('access-control-allow-origin'));
  });

  await t.test('Rate limiter returns 429 RATE_LIMITED when threshold exceeded', async () => {
    const testLimiter = createRateLimiter({ windowMs: 10000, max: 2 });
    const mockReq = { ip: '192.168.1.100', headers: {} };
    let statusSet = null;
    let jsonPayload = null;
    const mockRes = {
      status(s) { statusSet = s; return this; },
      json(j) { jsonPayload = j; return this; }
    };
    let nextCalled = 0;
    const next = () => { nextCalled++; };

    testLimiter(mockReq, mockRes, next); // 1st
    testLimiter(mockReq, mockRes, next); // 2nd
    testLimiter(mockReq, mockRes, next); // 3rd -> should trigger 429

    assert.equal(nextCalled, 2);
    assert.equal(statusSet, 429);
    assert.equal(jsonPayload?.error?.code, 'RATE_LIMITED');
  });

  await t.test('Express trust proxy is configured for reverse proxy environments', () => {
    assert.equal(app.get('trust proxy'), 1);
  });

  await t.test('POST /api/products enforces active products cap and returns 400 LIMIT_EXCEEDED', async () => {
    const originalMax = config.maxTrackedProducts;
    config.maxTrackedProducts = 1; // Temporarily cap at 1 (since live DB has 1 product: 459)

    try {
      const res = await fetch(`${baseUrl}/api/products`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ store_product_id: 'test-cap-overflow-999' })
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error?.code, 'LIMIT_EXCEEDED');
      assert.match(body.error?.message, /limit reached/);
    } finally {
      config.maxTrackedProducts = originalMax;
    }
  });
});

test('Level B5 Hotfix: Serialized Scrape Queue', async (t) => {
  await t.test('executes jobs sequentially in FIFO order', async () => {
    const executionOrder = [];
    scrapeQueue.clear();

    const job1 = scrapeQueue.enqueue({
      type: 'test-job-1',
      fn: async () => {
        await new Promise((r) => setTimeout(r, 50));
        executionOrder.push('job1');
        return 'res1';
      }
    });

    const job2 = scrapeQueue.enqueue({
      type: 'test-job-2',
      fn: async () => {
        executionOrder.push('job2');
        return 'res2';
      }
    });

    const [res1, res2] = await Promise.all([job1.promise, job2.promise]);
    assert.equal(res1, 'res1');
    assert.equal(res2, 'res2');
    assert.deepEqual(executionOrder, ['job1', 'job2']);
  });

  await t.test('rejects with QueueFullError when queue capacity is exceeded', () => {
    scrapeQueue.clear();
    const originalMax = scrapeQueue.maxSize;
    scrapeQueue.setMaxSize(2, 0);

    try {
      // Fill the queue
      scrapeQueue.enqueue({
        type: 'blocker',
        fn: () => new Promise((resolve) => setTimeout(resolve, 500))
      });
      scrapeQueue.enqueue({
        type: 'queued-1',
        fn: () => Promise.resolve()
      });
      scrapeQueue.enqueue({
        type: 'queued-2',
        fn: () => Promise.resolve()
      });

      // 4th should exceed bound of 2 in queue
      assert.throws(
        () => {
          scrapeQueue.enqueue({
            type: 'overflow',
            fn: () => Promise.resolve()
          });
        },
        (err) => {
          assert.equal(err.code, 'QUEUE_FULL');
          assert.match(err.message, /limit reached/);
          return true;
        }
      );
    } finally {
      scrapeQueue.setMaxSize(originalMax);
      scrapeQueue.clear();
    }
  });

  await t.test('cron cycles have a reserved queue slot so tracking jobs cannot crowd them out', () => {
    scrapeQueue.clear();
    const originalMax = scrapeQueue.maxSize;
    // Capacity of 3 with 1 reserved slot for cron -> tracking jobs cap at 2 pending
    scrapeQueue.setMaxSize(3, 1);

    try {
      // 1. Fill tracking quota (1 processing, 2 pending in queue = 2 pending tracking jobs)
      scrapeQueue.enqueue({
        type: 'product',
        fn: () => new Promise((resolve) => setTimeout(resolve, 500))
      });
      scrapeQueue.enqueue({
        type: 'product',
        fn: () => Promise.resolve()
      });
      scrapeQueue.enqueue({
        type: 'product',
        fn: () => Promise.resolve()
      });

      // 3rd pending tracking job must be rejected to preserve the reserved cron slot
      assert.throws(
        () => {
          scrapeQueue.enqueue({
            type: 'product',
            fn: () => Promise.resolve()
          });
        },
        (err) => {
          assert.equal(err.code, 'QUEUE_FULL');
          assert.match(err.message, /Slot reserved for scheduled cron cycle/);
          return true;
        }
      );

      // BUT a cron cycle CAN still be enqueued in the reserved slot!
      const cronJob = scrapeQueue.enqueue({
        type: 'cron',
        fn: () => Promise.resolve({ status: 'completed' })
      });
      assert.ok(cronJob.id);
      assert.equal(cronJob.position, 3);
    } finally {
      scrapeQueue.setMaxSize(originalMax);
      scrapeQueue.clear();
    }
  });
});

test('Level B6: Headed Scraper & Fault Injection Production Guard', async (t) => {
  await t.test('scrape-once.js aborts immediately if fault injection flags are passed in production mode', () => {
    const scriptPath = path.resolve(__dirname, '../scripts/scrape-once.js');
    
    // Attempt running with --simulate-slow and NODE_ENV=production
    try {
      execSync(`node "${scriptPath}" --simulate-slow`, {
        env: { ...process.env, NODE_ENV: 'production' },
        stdio: 'pipe'
      });
      assert.fail('Should have exited with non-zero code in production');
    } catch (err) {
      assert.equal(err.status, 1);
      const stderr = err.stderr.toString();
      assert.match(stderr, /strictly forbidden in production/i);
    }

    // Attempt running with --simulate-failure and NODE_ENV=production
    try {
      execSync(`node "${scriptPath}" --simulate-failure`, {
        env: { ...process.env, NODE_ENV: 'production' },
        stdio: 'pipe'
      });
      assert.fail('Should have exited with non-zero code in production');
    } catch (err) {
      assert.equal(err.status, 1);
      const stderr = err.stderr.toString();
      assert.match(stderr, /strictly forbidden in production/i);
    }
  });

  await t.test('POST /api/products ignores fault injection payload properties', async () => {
    const res = await fetch(`${baseUrl}/api/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        store_product_id: 'test-b6-guard-prod',
        simulate_slow: true,
        simulate_failure: true,
        simulateSlow: true
      })
    });

    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.product.simulate_slow, undefined);
    assert.equal(body.product.simulate_failure, undefined);
  });

  await t.test('POST /api/cron/scrape ignores fault injection query params', async () => {
    const res = await fetch(`${baseUrl}/api/cron/scrape?simulate_slow=true&simulate_failure=true`, {
      method: 'POST',
      headers: { 'x-cron-secret': config.cronSecret }
    });

    assert.equal(res.status, 202);
  });
});

test('Level B7: Protected Scrape Routes & Queue Integration', async (t) => {
  await t.test('POST /api/cron/scrape without secret returns 401 UNAUTHORIZED', async () => {
    const res = await fetch(`${baseUrl}/api/cron/scrape`, { method: 'POST' });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, 'UNAUTHORIZED');
  });

  await t.test('POST /api/cron/scrape with invalid secret returns 401 UNAUTHORIZED', async () => {
    const res = await fetch(`${baseUrl}/api/cron/scrape`, {
      method: 'POST',
      headers: { 'x-cron-secret': 'wrong-secret' }
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, 'UNAUTHORIZED');
  });

  await t.test('POST /api/cron/scrape with valid secret returns 202 and run_id', async () => {
    const res = await fetch(`${baseUrl}/api/cron/scrape`, {
      method: 'POST',
      headers: { 'x-cron-secret': config.cronSecret }
    });
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.status, 'accepted');
    assert.ok(body.run_id);
    assert.ok(typeof body.queue_position === 'number');
    scrapeQueue.clear();
  });

  await t.test('POST /api/cron/scrape returns 429 QUEUE_FULL when queue limit is reached', async () => {
    const originalQueue = [...scrapeQueue.queue];
    while (scrapeQueue.queue.length < scrapeQueue.maxSize) {
      scrapeQueue.queue.push({
        id: 'mock-filler-' + Math.random(),
        type: 'cron',
        fn: async () => {},
        resolve: () => {},
        reject: () => {}
      });
    }

    try {
      const res = await fetch(`${baseUrl}/api/cron/scrape`, {
        method: 'POST',
        headers: { 'x-cron-secret': config.cronSecret }
      });
      assert.equal(res.status, 429);
      const body = await res.json();
      assert.equal(body.status, 'skipped');
      assert.equal(body.error.code, 'QUEUE_FULL');
    } finally {
      scrapeQueue.queue = originalQueue;
    }
  });

  await t.test('POST /api/products/:id/scrape requires valid x-cron-secret', async () => {
    const resNoSecret = await fetch(`${baseUrl}/api/products/any-id/scrape`, { method: 'POST' });
    assert.equal(resNoSecret.status, 401);

    const resBadSecret = await fetch(`${baseUrl}/api/products/any-id/scrape`, {
      method: 'POST',
      headers: { 'x-cron-secret': 'bad' }
    });
    assert.equal(resBadSecret.status, 401);
  });

  await t.test('POST /api/products/:id/scrape returns 404 for nonexistent product', async () => {
    const res = await fetch(`${baseUrl}/api/products/non-existent-uuid/scrape`, {
      method: 'POST',
      headers: { 'x-cron-secret': config.cronSecret }
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, 'NOT_FOUND');
  });

  await t.test('POST /api/products/:id/scrape with existing product enqueues and returns 202', async () => {
    const trackRes = await fetch(`${baseUrl}/api/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ store_product_id: 'test-cron-force-scrape-prod', name: 'Cron Force Test' })
    });
    assert.equal(trackRes.status, 201);
    const trackBody = await trackRes.json();
    const productId = trackBody.product.id;

    const scrapeRes = await fetch(`${baseUrl}/api/products/${productId}/scrape`, {
      method: 'POST',
      headers: { 'x-cron-secret': config.cronSecret }
    });
    assert.equal(scrapeRes.status, 202);
    const scrapeBody = await scrapeRes.json();
    assert.equal(scrapeBody.status, 'accepted');
    assert.ok(scrapeBody.run_id);
    scrapeQueue.clear();
  });

  await t.test('POST /api/products/:id/scrape returns 429 when queue is full', async () => {
    const trackRes = await fetch(`${baseUrl}/api/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ store_product_id: 'test-cron-queue-full-prod', name: 'Cron Q Full Test' })
    });
    assert.equal(trackRes.status, 201);
    const trackBody = await trackRes.json();
    const productId = trackBody.product.id;

    const originalQueue = [...scrapeQueue.queue];
    while (scrapeQueue.queue.length < scrapeQueue.maxSize) {
      scrapeQueue.queue.push({
        id: 'mock-filler-' + Math.random(),
        type: 'product',
        fn: async () => {},
        resolve: () => {},
        reject: () => {}
      });
    }

    try {
      const res = await fetch(`${baseUrl}/api/products/${productId}/scrape`, {
        method: 'POST',
        headers: { 'x-cron-secret': config.cronSecret }
      });
      assert.equal(res.status, 429);
      const body = await res.json();
      assert.equal(body.status, 'skipped');
      assert.equal(body.error.code, 'QUEUE_FULL');
    } finally {
      scrapeQueue.queue = originalQueue;
    }
  });

  await t.test('POST /api/products/:id/refresh is PUBLIC and enqueues without secret', async () => {
    clearRefreshCooldowns();
    const trackRes = await fetch(`${baseUrl}/api/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ store_product_id: 'test-refresh-pub-prod', name: 'Refresh Pub Test' })
    });
    assert.equal(trackRes.status, 201);
    const trackBody = await trackRes.json();
    const productId = trackBody.product.id;

    // Call WITHOUT any secret or x-cron-secret header
    const refreshRes = await fetch(`${baseUrl}/api/products/${productId}/refresh`, {
      method: 'POST'
    });
    assert.equal(refreshRes.status, 202);
    const refreshBody = await refreshRes.json();
    assert.equal(refreshBody.status, 'accepted');
    assert.ok(refreshBody.run_id);
    clearRefreshCooldowns();
  });

  await t.test('POST /api/products/:id/refresh enforces 5-minute cooldown and returns 429', async () => {
    const trackRes = await fetch(`${baseUrl}/api/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ store_product_id: 'test-cooldown-prod', name: 'Cooldown Test' })
    });
    assert.equal(trackRes.status, 201);
    const trackBody = await trackRes.json();
    const productId = trackBody.product.id;

    clearRefreshCooldowns();
    // First refresh succeeds
    const firstRes = await fetch(`${baseUrl}/api/products/${productId}/refresh`, { method: 'POST' });
    assert.equal(firstRes.status, 202);

    // Second immediate refresh rejected by 5-minute cooldown
    const secondRes = await fetch(`${baseUrl}/api/products/${productId}/refresh`, { method: 'POST' });
    assert.equal(secondRes.status, 429);
    assert.ok(secondRes.headers.get('Retry-After'));
    const body = await secondRes.json();
    assert.equal(body.error?.code, 'COOLDOWN_ACTIVE');
    assert.ok(body.error?.retry_after_seconds > 0);
    clearRefreshCooldowns();
  });

  await t.test('POST /api/products/:id/refresh returns 429 when queue is full', async () => {
    const trackRes = await fetch(`${baseUrl}/api/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ store_product_id: 'test-refresh-queue-full-prod', name: 'Refresh Q Full Test' })
    });
    assert.equal(trackRes.status, 201);
    const trackBody = await trackRes.json();
    const productId = trackBody.product.id;

    clearRefreshCooldowns();
    const originalQueue = [...scrapeQueue.queue];
    while (scrapeQueue.queue.length < scrapeQueue.maxSize) {
      scrapeQueue.queue.push({
        id: 'mock-filler-' + Math.random(),
        type: 'product',
        fn: async () => {},
        resolve: () => {},
        reject: () => {}
      });
    }

    try {
      const res = await fetch(`${baseUrl}/api/products/${productId}/refresh`, { method: 'POST' });
      assert.equal(res.status, 429);
      const body = await res.json();
      assert.equal(body.status, 'skipped');
      assert.equal(body.error?.code, 'QUEUE_FULL');
    } finally {
      scrapeQueue.queue = originalQueue;
      clearRefreshCooldowns();
    }
  });
});

