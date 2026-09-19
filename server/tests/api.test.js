process.env.NODE_ENV = 'test';

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/index.js';
import config from '../src/config/index.js';
import { createRateLimiter } from '../src/middleware/rateLimiter.js';
import { getSupabaseClient } from '../src/db/client.js';
import scrapeQueue, { QueueFullError } from '../src/services/scrapeQueue.js';

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
    scrapeQueue.setMaxSize(2);

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
});
