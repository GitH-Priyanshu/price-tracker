import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import config from '../src/config/index.js';
import { scrapeProduct } from '../src/services/storeClient.js';
import { closeBrowser } from '../src/services/browserScraper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const evidenceDir = path.resolve(__dirname, '../../docs/evidence');
if (!fs.existsSync(evidenceDir)) {
  fs.mkdirSync(evidenceDir, { recursive: true });
}

function quantile(arr, q) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return Math.round(sorted[base] + rest * (sorted[base + 1] - sorted[base]));
  }
  return Math.round(sorted[base]);
}

async function runBenchmark() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  console.log('================================================================');
  console.log(`20-SCRAPE HEADLESS BENCHMARK (DRY RUN - ZERO DB WRITES)`);
  console.log(`Timestamp: ${timestamp}`);
  console.log('================================================================\n');

  // Query catalog for 5 real products
  let products = [];
  try {
    const res = await fetch(`${config.storeBaseUrl}/api/catalog?page=1&pageSize=10`);
    const data = await res.json();
    if (data.items && data.items.length >= 5) {
      products = data.items.slice(0, 5).map((item) => ({
        store_product_id: String(item.id),
        name: item.name,
        category: item.category,
        sku: item.sku || `SKU-${item.id}`
      }));
    }
  } catch (e) {
    console.error('Failed to load catalog via API:', e.message);
  }

  if (products.length < 5) {
    products = [
      { store_product_id: '120', name: 'Auralite Docking Station Mini', sku: 'AUR-10120' },
      { store_product_id: '459', name: 'Domus Sling Plus', sku: 'DOM-459' },
      { store_product_id: '329', name: 'Cobalt Ultrabook Lite', sku: 'COB-329' },
      { store_product_id: '905', name: 'Vista Monitor Studio', sku: 'VIS-905' },
      { store_product_id: '714', name: 'Nimbus Mechanical Keyboard', sku: 'NIM-714' }
    ];
  }

  console.log('Target Products:');
  products.forEach((p, idx) => console.log(`  [${idx + 1}] ID: ${p.store_product_id} - ${p.name} (SKU: ${p.sku})`));
  console.log('\nExecuting 20 scrapes (4 runs per product in headless mode)...\n');

  const runs = [];
  const durations = [];
  let peakRss = 0;

  let currentRun = 0;
  for (let round = 1; round <= 4; round++) {
    for (let pIdx = 0; pIdx < products.length; pIdx++) {
      currentRun++;
      const product = products[pIdx];

      const start = Date.now();
      let scrapeResult = null;

      try {
        scrapeResult = await scrapeProduct(product, { headed: false });
      } catch (err) {
        scrapeResult = {
          success: false,
          attempts: 1,
          error_type: 'FATAL_ERROR',
          error_message: err.message
        };
      }

      const durationMs = Date.now() - start;
      durations.push(durationMs);

      const mem = process.memoryUsage();
      if (mem.rss > peakRss) peakRss = mem.rss;

      const outcome = scrapeResult.success
        ? (scrapeResult.attempts > 1 ? 'retried' : 'success')
        : 'failed';

      const runData = {
        run_number: currentRun,
        product_id: product.store_product_id,
        product_name: product.name,
        product_sku: product.sku,
        outcome,
        attempts: scrapeResult.attempts || 1,
        duration_ms: durationMs,
        price_inr: scrapeResult.data?.price != null ? scrapeResult.data.price : null,
        stock_status: scrapeResult.data?.stock_status || null,
        stock_quantity: scrapeResult.data?.stock_quantity ?? null,
        attempt_details: scrapeResult.attempt_details || []
      };

      runs.push(runData);
      console.log(
        `[Run ${String(currentRun).padStart(2)}/20] Prod ${runData.product_id} (${runData.product_name}): ` +
        `Outcome=${runData.outcome.toUpperCase()}, Attempts=${runData.attempts}, ` +
        `Price=${runData.price_inr != null ? '₹' + runData.price_inr : 'N/A'}, ` +
        `Duration=${durationMs}ms`
      );
    }
  }

  const successCount = runs.filter(r => r.outcome === 'success').length;
  const retriedCount = runs.filter(r => r.outcome === 'retried').length;
  const failedCount = runs.filter(r => r.outcome === 'failed').length;
  const stalledBeyond10sCount = runs.filter(r => r.duration_ms > 10000).length;

  const minDuration = Math.min(...durations);
  const maxDuration = Math.max(...durations);
  const medianDuration = quantile(durations, 0.5);
  const p90Duration = quantile(durations, 0.9);
  const p95Duration = quantile(durations, 0.95);
  const avgDuration = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);

  const report = {
    benchmark_metadata: {
      timestamp,
      total_runs: runs.length,
      mode: 'headless',
      concurrency: 1,
      products_tested: products.length
    },
    summary_statistics: {
      total_runs: runs.length,
      first_try_success_count: successCount,
      retried_success_count: retriedCount,
      failed_count: failedCount,
      stalled_beyond_10s_count: stalledBeyond10sCount,
      first_try_success_rate_percent: Number(((successCount / runs.length) * 100).toFixed(1)),
      overall_success_rate_percent: Number((((successCount + retriedCount) / runs.length) * 100).toFixed(1)),
      duration_min_ms: minDuration,
      duration_median_ms: medianDuration,
      duration_avg_ms: avgDuration,
      duration_p90_ms: p90Duration,
      duration_p95_ms: p95Duration,
      duration_max_ms: maxDuration,
      peak_rss_mb: Number((peakRss / (1024 * 1024)).toFixed(1))
    },
    runs
  };

  const outputPath = path.join(evidenceDir, `benchmark_results_${timestamp}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n================================================================`);
  console.log(`BENCHMARK COMPLETED SUCCESSFULLY!`);
  console.log(`Raw evidence saved to: ${outputPath}`);
  console.log(`Summary:`);
  console.log(`  First-Try Success: ${successCount}/${runs.length} (${report.summary_statistics.first_try_success_rate_percent}%)`);
  console.log(`  Retried Success:   ${retriedCount}/${runs.length}`);
  console.log(`  Failed:            ${failedCount}/${runs.length}`);
  console.log(`  Stalls (>10s):     ${stalledBeyond10sCount}`);
  console.log(`  Durations: Min=${minDuration}ms, Median=${medianDuration}ms, p95=${p95Duration}ms, Max=${maxDuration}ms`);
  console.log(`================================================================\n`);

  await closeBrowser();
}

runBenchmark().catch(async (e) => {
  console.error('Fatal benchmark failure:', e);
  await closeBrowser();
});
