import test from 'node:test';
import assert from 'node:assert/strict';
import { runScrapeCycle, RUNNER_TEST_TOKEN } from '../src/services/scrapeRunner.js';
import {
  createProduct,
  getPriceHistory,
  getScrapeLogs,
  getSupabaseClient
} from '../src/db/index.js';

test('Scrape Runner Orchestration & Honest Logging', async (t) => {
  const supabase = getSupabaseClient();
  const testStoreIdSuccess = 'test-runner-success-prod';
  const testStoreIdFail = 'test-runner-fail-prod';

  // SAFETY GUARD: Abort immediately if any test store ID does not start with 'test-'
  assert.ok(
    testStoreIdSuccess.startsWith('test-') && testStoreIdFail.startsWith('test-'),
    'CRITICAL SAFETY GUARD: All test product store IDs must begin with "test-"'
  );

  let successProduct = null;
  let failProduct = null;

  try {
    // Setup test-only products
    successProduct = await createProduct({
      store_product_id: testStoreIdSuccess,
      name: 'Runner Success Test Product',
      url: 'https://demo.inelabteamdev.com/product/459'
    });

    failProduct = await createProduct({
      store_product_id: testStoreIdFail,
      name: 'Runner Fail Test Product',
      url: 'https://demo.inelabteamdev.com/product/invalid-99999'
    });

    // Double check that created products strictly follow test prefix
    assert.ok(successProduct.store_product_id.startsWith('test-'));
    assert.ok(failProduct.store_product_id.startsWith('test-'));

    // Clean slate for test products in case of prior interrupted runs
    await supabase.from('scrape_logs').delete().eq('product_id', successProduct.id);
    await supabase.from('price_history').delete().eq('product_id', successProduct.id);
    await supabase.from('scrape_logs').delete().eq('product_id', failProduct.id);
    await supabase.from('price_history').delete().eq('product_id', failProduct.id);

    const testProducts = [successProduct, failProduct];

    await t.test('one failing product does not stop others and records honest outcomes', async () => {
      const mockScraper = async (product) => {
        if (product.store_product_id === testStoreIdSuccess) {
          return {
            success: true,
            attempts: 1,
            data: {
              store_product_id: testStoreIdSuccess,
              name: 'Runner Success Test Product',
              price: 1500,
              stock_status: 'in_stock',
              stock_quantity: 10
            },
            http_status: 200,
            attempt_details: [{ attempt: 1, outcome: 'success', duration_ms: 100 }]
          };
        } else {
          return {
            success: false,
            attempts: 3,
            error_type: 'HTTP_4XX',
            error_message: 'Product page returned 404',
            http_status: 404,
            attempt_details: [
              { attempt: 1, outcome: 'failed', error_type: 'HTTP_4XX', error_message: 'Product page returned 404' }
            ]
          };
        }
      };

      // Explicitly pass testProducts and unforgeable testToken
      const cycle = await runScrapeCycle({
        products: testProducts,
        testToken: RUNNER_TEST_TOKEN,
        force: true,
        scraperFn: mockScraper
      });

      assert.ok(cycle.run_id);
      assert.equal(cycle.counts.success, 1, 'Exactly 1 test product should succeed');
      assert.equal(cycle.counts.failed, 1, 'Exactly 1 test product should fail');

      // 1. Verify success product has both price_history AND scrape_logs
      const successHistory = await getPriceHistory(successProduct.id);
      assert.equal(successHistory.length, 1);
      assert.equal(Number(successHistory[0].price), 1500);

      const successLogs = await getScrapeLogs(successProduct.id);
      assert.equal(successLogs.total, 1);
      assert.equal(successLogs.logs[0].status, 'success');
      assert.equal(successLogs.logs[0].price_history_id, successHistory[0].id);

      // 2. CRITICAL RULE: Verify fail product has NOTHING in price_history
      const failHistory = await getPriceHistory(failProduct.id);
      assert.equal(failHistory.length, 0, 'Price history MUST remain empty on failure');

      // 3. Verify fail product HAS a scrape_log entry with status 'failed'
      const failLogs = await getScrapeLogs(failProduct.id);
      assert.equal(failLogs.total, 1);
      assert.equal(failLogs.logs[0].status, 'failed');
      assert.equal(failLogs.logs[0].error_type, 'HTTP_4XX');
      assert.equal(failLogs.logs[0].price_history_id, null);
    });

    await t.test('duplicate-trigger guard skips recently scraped products when force is false', async () => {
      const mockScraper = async () => ({
        success: true,
        attempts: 1,
        data: { price: 2000, stock_status: 'in_stock' }
      });

      const cycle = await runScrapeCycle({
        products: testProducts,
        testToken: RUNNER_TEST_TOKEN,
        force: false,
        scraperFn: mockScraper
      });

      // Products scraped less than 10 minutes ago should be skipped
      assert.equal(cycle.counts.skipped, 2, 'Both test products should be skipped by dedupe guard');
    });

    await t.test('scrape queue serializes overlapping cycles without dropping triggers', async () => {
      let resolver;
      const blockingPromise = new Promise((resolve) => {
        resolver = resolve;
      });

      const executionOrder = [];
      const slowScraper = async () => {
        await blockingPromise;
        executionOrder.push('cycle1');
        return { success: true, attempts: 1, data: { price: 500, stock_status: 'in_stock' } };
      };

      const secondScraper = async () => {
        executionOrder.push('cycle2');
        return { success: true, attempts: 1, data: { price: 600, stock_status: 'in_stock' } };
      };

      const firstCyclePromise = runScrapeCycle({
        products: [successProduct],
        testToken: RUNNER_TEST_TOKEN,
        force: true,
        scraperFn: slowScraper
      });

      const secondCyclePromise = runScrapeCycle({
        products: [successProduct],
        testToken: RUNNER_TEST_TOKEN,
        force: true,
        scraperFn: secondScraper
      });

      // Release first cycle
      resolver();

      const [firstCycle, secondCycle] = await Promise.all([firstCyclePromise, secondCyclePromise]);
      assert.ok(firstCycle.run_id);
      assert.ok(secondCycle.run_id);
      assert.notEqual(firstCycle.run_id, secondCycle.run_id);
      assert.deepEqual(executionOrder, ['cycle1', 'cycle2']);
    });

    await t.test('runScrapeCycle without products argument invokes listActiveProducts loader', async () => {
      let loaderCalled = false;
      const fakeLoader = async () => {
        loaderCalled = true;
        return [successProduct];
      };

      const mockScraper = async (p) => ({
        success: true,
        attempts: 1,
        data: {
          store_product_id: p.store_product_id,
          name: p.name,
          price: 999,
          stock_status: 'in_stock',
          stock_quantity: 5
        },
        http_status: 200,
        attempt_details: [{ attempt: 1, outcome: 'success', duration_ms: 50 }]
      });

      // Call runScrapeCycle WITHOUT 'products' argument, using injected loader
      const cycle = await runScrapeCycle({
        testToken: RUNNER_TEST_TOKEN,
        listActiveProductsFn: fakeLoader,
        force: true,
        scraperFn: mockScraper
      });

      assert.ok(loaderCalled, 'Should have invoked product loader');
      assert.ok(cycle.run_id);
      assert.equal(cycle.counts.total, 1);
      assert.equal(cycle.results[0].storeProductId, testStoreIdSuccess);
    });

    await t.test('safety guard strictly aborts if real product is passed in test mode', async () => {
      const illegalProduct = { store_product_id: '459', name: 'Real Live Product' };
      await assert.rejects(
        () => runScrapeCycle({ products: [illegalProduct], testToken: RUNNER_TEST_TOKEN }),
        /SAFETY GUARD VIOLATION/
      );
    });

    await t.test('safety guard cannot be bypassed by testOnly boolean or strings from API/env', async () => {
      // Attempting to pass test- product without valid Symbol token must be rejected as a live run violation
      await assert.rejects(
        () => runScrapeCycle({ products: [successProduct], testOnly: true }),
        /SAFETY GUARD VIOLATION/
      );
      await assert.rejects(
        () => runScrapeCycle({ products: [successProduct], testToken: 'RUNNER_TEST_TOKEN' }),
        /SAFETY GUARD VIOLATION/
      );
    });
  } finally {
    // Thorough cleanup: delete all test products (cascades to price_history and scrape_logs)
    if (successProduct) {
      await supabase.from('products').delete().eq('id', successProduct.id);
    }
    if (failProduct) {
      await supabase.from('products').delete().eq('id', failProduct.id);
    }
    await supabase.from('products').delete().like('store_product_id', 'test-%');
  }
});
