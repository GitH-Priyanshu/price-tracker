import { runScrapeCycle } from '../src/services/scrapeRunner.js';
import { closeBrowser } from '../src/services/browserScraper.js';
import {
  listActiveProducts,
  createProduct,
  getPriceHistory,
  getScrapeLogs,
  getSupabaseClient
} from '../src/db/index.js';

async function main() {
  console.log('================================================================');
  console.log('RUN SCRAPE CYCLE: LOCAL ORCHESTRATION TEST');
  console.log('================================================================\n');

  const supabase = getSupabaseClient();

  // 1. Check if at least one active product exists to scrape
  let activeProducts = await listActiveProducts();
  if (activeProducts.length === 0) {
    console.log('[Setup] No active tracked products found. Seeding Product 459 (Domus Sling Plus)...');
    const seeded = await createProduct({
      store_product_id: '459',
      name: 'Domus Sling Plus',
      url: 'https://demo.inelabteamdev.com/product/459',
      category: 'Bags',
      brand: 'Domus',
      sku: 'DOM-10459'
    });
    console.log(`[Setup] Seeded product id: ${seeded.id} (store_product_id: ${seeded.store_product_id})\n`);
    activeProducts = [seeded];
  }

  // 2. Run scrape cycle with force=true to ensure execution
  console.log(`Starting scrape cycle for ${activeProducts.length} product(s)...`);
  const cycleResult = await runScrapeCycle({ force: true });

  console.log('\n================================================================');
  console.log('CYCLE EXECUTION SUMMARY:');
  console.log(`  Run ID:    ${cycleResult.run_id}`);
  console.log(`  Duration:  ${cycleResult.duration_ms}ms`);
  console.log(`  Counts:    Total=${cycleResult.counts.total}, Success=${cycleResult.counts.success}, ` +
              `Retried=${cycleResult.counts.retried}, Failed=${cycleResult.counts.failed}, Skipped=${cycleResult.counts.skipped}`);
  console.log('================================================================\n');

  // 3. Query and display the newly inserted rows from Supabase
  for (const product of activeProducts) {
    console.log(`Verifying Supabase records for "${product.name}" (${product.id}):`);
    
    // Check price_history
    const history = await getPriceHistory(product.id);
    console.log(`  📊 price_history rows: ${history.length}`);
    if (history.length > 0) {
      const latest = history[history.length - 1];
      console.log(`     Latest: ₹${latest.price} | Status: ${latest.stock_status} | ScrapedAt: ${latest.scraped_at}`);
    }

    // Check scrape_logs
    const { logs, total } = await getScrapeLogs(product.id, 5);
    console.log(`  📝 scrape_logs rows:    ${total}`);
    if (logs.length > 0) {
      const latestLog = logs[0];
      console.log(`     Latest Log: Status=${latestLog.status}, Attempts=${latestLog.attempts}, ` +
                  `Duration=${latestLog.duration_ms}ms, PriceHistoryId=${latestLog.price_history_id}`);
    }
    console.log('');
  }

  await closeBrowser();
  console.log('Local cycle execution finished successfully.');
  process.exit(0);
}

main().catch(async (e) => {
  console.error('Fatal error in run-cycle script:', e);
  await closeBrowser();
  process.exit(1);
});
