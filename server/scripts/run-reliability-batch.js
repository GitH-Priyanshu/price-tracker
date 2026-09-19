import config from '../src/config/index.js';
import { scrapeProduct } from '../src/services/storeClient.js';
import { closeBrowser } from '../src/services/browserScraper.js';

async function runReliabilityBatch() {
  console.log('================================================================');
  console.log('LIVE HEADLESS RELIABILITY BATCH (DRY RUN - ZERO DB WRITES)');
  console.log('Target: 15 scrapes across 5 distinct mock store products');
  console.log('Mode: Headless Chromium');
  console.log('================================================================\n');

  // 1. Fetch 5 products from catalog
  let products = [];
  try {
    const res = await fetch(`${config.storeBaseUrl}/api/catalog?page=1&pageSize=10`);
    const data = await res.json();
    if (data.items && data.items.length >= 5) {
      products = data.items.slice(0, 5).map((item) => ({
        store_product_id: String(item.id),
        name: item.name,
        category: item.category
      }));
    }
  } catch (e) {
    console.error('Failed to fetch catalog products:', e);
  }

  if (products.length < 5) {
    // Fallback known catalog IDs
    products = [
      { store_product_id: '459', name: 'Domus Sling Plus', category: 'Bags' },
      { store_product_id: '329', name: 'Cobalt Ultrabook Lite', category: 'Laptops' },
      { store_product_id: '905', name: 'Vista Monitor Studio', category: 'Monitors' },
      { store_product_id: '120', name: 'Aero Wireless Buds', category: 'Audio' },
      { store_product_id: '714', name: 'Nimbus Mechanical Keyboard', category: 'Keyboards' }
    ];
  }

  console.log(`Testing 5 products:`);
  products.forEach((p, i) => console.log(`  [${i + 1}] ID: ${p.store_product_id} - ${p.name} (${p.category})`));
  console.log('\nExecuting 15 headless scrape runs (3 runs per product)...\n');

  const batchResults = [];
  let peakRssBytes = 0;
  let peakHeapBytes = 0;

  const totalRuns = 15;
  let currentRun = 0;

  for (let pIdx = 0; pIdx < products.length; pIdx++) {
    const product = products[pIdx];

    for (let round = 1; round <= 3; round++) {
      currentRun++;
      const memBefore = process.memoryUsage();

      const start = Date.now();
      let scrapeResult = null;

      try {
        scrapeResult = await scrapeProduct(product, { headed: false });
      } catch (err) {
        scrapeResult = {
          success: false,
          attempts: 1,
          error_type: 'PARSE_ERROR',
          error_message: err.message
        };
      }

      const durationMs = Date.now() - start;
      const memAfter = process.memoryUsage();
      if (memAfter.rss > peakRssBytes) peakRssBytes = memAfter.rss;
      if (memAfter.heapUsed > peakHeapBytes) peakHeapBytes = memAfter.heapUsed;

      const outcome = scrapeResult.success
        ? (scrapeResult.attempts > 1 ? 'retried' : 'success')
        : 'failed';

      const row = {
        runIndex: currentRun,
        productId: product.store_product_id,
        name: product.name,
        category: product.category,
        outcome,
        attempts: scrapeResult.attempts || 1,
        price: scrapeResult.data?.price != null ? `₹${scrapeResult.data.price}` : 'N/A',
        stock: scrapeResult.data?.stock_status
          ? `${scrapeResult.data.stock_status} (${scrapeResult.data.stock_quantity ?? '?'})`
          : 'N/A',
        durationMs,
        rssMb: (memAfter.rss / (1024 * 1024)).toFixed(1)
      };

      batchResults.push(row);
      console.log(
        `[Run ${String(currentRun).padStart(2)}/15] Prod ${row.productId} (${row.name}): ` +
        `Outcome=${row.outcome.toUpperCase()}, Attempts=${row.attempts}, Price=${row.price}, ` +
        `Stock=${row.stock}, Duration=${durationMs}ms, RSS=${row.rssMb}MB`
      );

      // Brief polite delay between headless scrapes
      await new Promise((r) => setTimeout(r, 600));
    }
  }

  await closeBrowser();

  // Summary tallies
  const counts = {
    total: batchResults.length,
    success: batchResults.filter((r) => r.outcome === 'success').length,
    retried: batchResults.filter((r) => r.outcome === 'retried').length,
    failed: batchResults.filter((r) => r.outcome === 'failed').length
  };

  const avgDuration = Math.round(
    batchResults.reduce((acc, r) => acc + r.durationMs, 0) / batchResults.length
  );

  console.log('\n================================================================');
  console.log('RELIABILITY BATCH SUMMARY (HEADLESS PLAYWRIGHT DRY RUN)');
  console.log('================================================================');
  console.log(`Total Runs:       ${counts.total}`);
  console.log(`Success:          ${counts.success}`);
  console.log(`Retried:          ${counts.retried}`);
  console.log(`Failed:           ${counts.failed}`);
  console.log(`Average Duration: ${avgDuration}ms`);
  console.log(`Peak RSS Memory:  ${(peakRssBytes / (1024 * 1024)).toFixed(1)} MB`);
  console.log(`Peak Heap Used:   ${(peakHeapBytes / (1024 * 1024)).toFixed(1)} MB`);
  console.log('Database Writes:  0 (Strict dry run)');
  console.log('================================================================\n');

  // Format markdown table
  console.log('### Markdown Results Table:\n');
  console.log('| Run | Product ID | Product Name | Category | Outcome | Attempts | Price | Stock Status & Qty | Duration | RSS Mem |');
  console.log('| :-: | :--------: | :----------- | :------- | :-----: | :------: | :---: | :----------------- | :------: | :-----: |');
  for (const r of batchResults) {
    console.log(
      `| ${r.runIndex} | ${r.productId} | ${r.name} | ${r.category} | **${r.outcome}** | ${r.attempts} | ${r.price} | ${r.stock} | ${r.durationMs}ms | ${r.rssMb}MB |`
    );
  }
}

runReliabilityBatch().catch(async (e) => {
  console.error('Fatal batch error:', e);
  await closeBrowser();
  process.exit(1);
});
