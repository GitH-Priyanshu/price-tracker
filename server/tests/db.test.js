import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProduct,
  getProductByStoreId,
  listActiveProducts,
  getProduct,
  deactivateProduct,
  insertPriceHistory,
  getPriceHistory,
  insertScrapeLog,
  getScrapeLogs,
  getLatestPrice,
  updateProductScrapeStatus,
  getMostRecentLogStart,
  getSupabaseClient
} from '../src/db/index.js';

test('Data Layer Integrity Rules (Unit Logic)', async (t) => {
  await t.test('insertPriceHistory rejects non-positive or NaN prices', async () => {
    await assert.rejects(
      () => insertPriceHistory({ product_id: '00000000-0000-0000-0000-000000000000', price: 0, stock_status: 'in_stock' }),
      /Data Integrity Violation/
    );
    await assert.rejects(
      () => insertPriceHistory({ product_id: '00000000-0000-0000-0000-000000000000', price: -50, stock_status: 'in_stock' }),
      /Data Integrity Violation/
    );
    await assert.rejects(
      () => insertPriceHistory({ product_id: '00000000-0000-0000-0000-000000000000', price: NaN, stock_status: 'in_stock' }),
      /Data Integrity Violation/
    );
  });

  await t.test('insertPriceHistory rejects invalid stock status', async () => {
    await assert.rejects(
      () => insertPriceHistory({ product_id: '00000000-0000-0000-0000-000000000000', price: 100, stock_status: 'unknown_status' }),
      /Data Integrity Violation/
    );
  });

  await t.test('insertScrapeLog rejects invalid log status', async () => {
    await assert.rejects(
      () => insertScrapeLog({ status: 'invalid_status' }),
      /Invalid scrape log status/
    );
  });
});

test('Live Database Operations & Lifecycle', async (t) => {
  const supabase = getSupabaseClient();
  
  // Probe if tables exist before attempting live queries
  const { error: probeError } = await supabase.from('products').select('id').limit(1);
  if (probeError && probeError.code === 'PGRST205') {
    t.diagnostic('Notice: /supabase/schema.sql has not been executed in Supabase SQL editor yet. Skipping live database operations.');
    return;
  }

  const testStoreId = 'test-probe-unit-b2';
  let createdProductId = null;

  try {
    await t.test('createProduct creates and returns a new product record', async () => {
      const product = await createProduct({
        store_product_id: testStoreId,
        name: 'Unit Test Product B2',
        url: 'https://demo.inelabteamdev.com/product/test',
        category: 'Test Category',
        brand: 'Test Brand'
      });

      assert.ok(product.id, 'Product should have generated UUID');
      assert.equal(product.store_product_id, testStoreId);
      assert.equal(product.is_active, true);
      createdProductId = product.id;
    });

    await t.test('getProduct and getProductByStoreId return the created product', async () => {
      const byStore = await getProductByStoreId(testStoreId);
      assert.ok(byStore);
      assert.equal(byStore.id, createdProductId);

      const byId = await getProduct(createdProductId);
      assert.ok(byId);
      assert.equal(byId.name, 'Unit Test Product B2');
    });

    await t.test('createProduct is idempotent on store_product_id', async () => {
      const updated = await createProduct({
        store_product_id: testStoreId,
        name: 'Unit Test Product B2 Renamed',
        category: 'Updated Category'
      });

      assert.equal(updated.id, createdProductId);
      assert.equal(updated.name, 'Unit Test Product B2 Renamed');
    });

    await t.test('insertPriceHistory writes validated history and getLatestPrice reads it', async () => {
      const inserted = await insertPriceHistory({
        product_id: createdProductId,
        price: 1999.99,
        stock_status: 'in_stock',
        stock_quantity: 42
      });

      assert.ok(inserted.id);
      assert.equal(Number(inserted.price), 1999.99);
      assert.equal(inserted.stock_status, 'in_stock');
      assert.equal(inserted.stock_quantity, 42);

      const latest = await getLatestPrice(createdProductId);
      assert.ok(latest);
      assert.equal(Number(latest.price), 1999.99);

      const history = await getPriceHistory(createdProductId, '24h');
      assert.equal(history.length, 1);
      assert.equal(Number(history[0].price), 1999.99);
    });

    await t.test('insertScrapeLog records honest attempt details', async () => {
      const runId = '11111111-2222-3333-4444-555555555555';
      const log = await insertScrapeLog({
        product_id: createdProductId,
        run_id: runId,
        started_at: new Date(Date.now() - 5000).toISOString(),
        finished_at: new Date().toISOString(),
        status: 'success',
        attempts: 1,
        http_status: 200,
        duration_ms: 1200,
        attempt_details: [{ attempt: 1, outcome: 'success', duration_ms: 1200 }]
      });

      assert.ok(log.id);
      assert.equal(log.status, 'success');
      assert.equal(log.attempts, 1);

      const { logs, total } = await getScrapeLogs(createdProductId);
      assert.equal(total, 1);
      assert.equal(logs[0].run_id, runId);

      const lastStart = await getMostRecentLogStart(createdProductId);
      assert.ok(lastStart instanceof Date);
    });

    await t.test('updateProductScrapeStatus updates status and timestamp', async () => {
      const updated = await updateProductScrapeStatus(createdProductId, 'success');
      assert.equal(updated.last_status, 'success');
      assert.ok(updated.last_scraped_at);
    });

    await t.test('deactivateProduct deactivates and removes from listActiveProducts', async () => {
      const deactivated = await deactivateProduct(createdProductId);
      assert.equal(deactivated.is_active, false);

      const activeList = await listActiveProducts();
      const stillInList = activeList.some((p) => p.id === createdProductId);
      assert.equal(stillInList, false);
    });
  } finally {
    // Clean up test product and cascade delete history and logs
    if (createdProductId) {
      await supabase.from('products').delete().eq('id', createdProductId);
    }
  }
});
