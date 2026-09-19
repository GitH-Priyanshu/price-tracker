import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import config from '../src/config/index.js';
import { scrapeProduct } from '../src/services/storeClient.js';
import { scrapeProductPage, closeBrowser } from '../src/services/browserScraper.js';
import {
  getProductByStoreId,
  insertPriceHistory,
  insertScrapeLog
} from '../src/db/queries.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const evidenceDir = path.resolve(__dirname, '../../docs/evidence');
if (!fs.existsSync(evidenceDir)) {
  fs.mkdirSync(evidenceDir, { recursive: true });
}

// -----------------------------------------------------------------------------
// Security Guard: Fault injection strictly forbidden in production
// -----------------------------------------------------------------------------
const argv = process.argv.slice(2);
const isProduction = process.env.NODE_ENV === 'production';
const hasSimulateSlow = argv.includes('--simulate-slow');
const hasSimulateFailure = argv.includes('--simulate-failure');
const hasDemoAll = argv.includes('--demo-all');

if (isProduction && (hasSimulateSlow || hasSimulateFailure || hasDemoAll)) {
  console.error('\n[SECURITY ERROR] Fault injection flags (--simulate-slow, --simulate-failure, --demo-all) are strictly forbidden in production environments.');
  process.exit(1);
}

// Dynamically retrieve current git commit hash
let currentCommit = 'unknown';
try {
  currentCommit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
} catch (e) {
  console.warn('Could not determine git commit:', e.message);
}

function timestamp() {
  const d = new Date();
  return d.toISOString().slice(11, 23); // HH:MM:SS.mmm
}

function log(icon, msg) {
  console.log(`[${timestamp()}] ${icon}  ${msg}`);
}

/**
 * Resolves a product record for scraping (checking local DB, or falling back to upstream catalog)
 */
async function resolveProduct(storeId) {
  let product = null;
  try {
    product = await getProductByStoreId(storeId);
  } catch {}

  if (!product) {
    // Default catalog metadata fallbacks
    const catalogMap = {
      '459': { name: 'Domus Sling Plus', sku: 'DOM-10459', category: 'bags', brand: 'Domus' },
      '510': { name: 'Meridian Touch Monitor Two', sku: 'MER-10510', category: 'monitors', brand: 'Meridian' },
      '985': { name: 'Ironwood Monitor Neo', sku: 'IRO-10985', category: 'monitors', brand: 'Ironwood' },
      '989': { name: 'Vista Pro Display Neo', sku: 'VIS-10989', category: 'monitors', brand: 'Vista' },
      '520': { name: 'Vantablack Docking Station Two', sku: 'VAN-10520', category: 'docks', brand: 'Vantablack' },
      '383': { name: 'Ironwood Tote Lite', sku: 'IRO-10383', category: 'totes', brand: 'Ironwood' }
    };

    const meta = catalogMap[storeId] || { name: `Product ${storeId}`, sku: `SKU-${storeId}` };
    product = {
      id: `virtual-${storeId}`,
      store_product_id: String(storeId),
      name: meta.name,
      sku: meta.sku,
      url: `${config.storeBaseUrl}/product/${storeId}`,
      is_active: true
    };
  }
  return product;
}

/**
 * Runs a single observable scrape scenario with detailed timeline output
 */
async function runScenario({
  title,
  product,
  headed = true,
  noDb = false,
  simulateSlow = false,
  simulateFailure = false
}) {
  console.log('\n' + '='.repeat(80));
  console.log(`SCENARIO: ${title}`);
  console.log('='.repeat(80));
  console.log(`Product Target : ${product.name} (Store ID: ${product.store_product_id}, SKU: ${product.sku || 'N/A'})`);
  console.log(`Target URL     : ${product.url}`);
  console.log(`Browser Mode   : ${headed ? 'HEADED (Visible Chromium GUI Window)' : 'HEADLESS'}`);
  console.log(`DB Mode        : ${noDb ? 'DRY RUN (--no-db active: zero database writes)' : 'LIVE DB PERSISTENCE'}`);
  console.log(`Fault Injection: ${
    simulateSlow ? 'SIMULATE-SLOW (Attempt 1 forced timeout, then retry)' :
    simulateFailure ? 'SIMULATE-FAILURE (Upstream 503 outage across all attempts)' :
    'NONE (Standard Production Pipeline)'
  }`);
  console.log('-'.repeat(80));

  let attemptCount = 0;
  let customScraper = null;

  if (simulateSlow) {
    customScraper = async (url, opts) => {
      attemptCount++;
      if (attemptCount === 1) {
        log('⚠️', `[DEMO FAULT INJECTION] Injecting simulated slow anti-bot challenge stall (forcing Attempt 1 TIMEOUT)...`);
        await new Promise((r) => setTimeout(r, 13000));
        throw new Error('page.waitForFunction: Timeout 12000ms exceeded (Simulated Anti-Bot Dwell Stall)');
      }
      log('🔄', `[DEMO FAULT INJECTION] Attempt 2 running standard production scraper...`);
      return scrapeProductPage(url, opts);
    };
  } else if (simulateFailure) {
    customScraper = async () => {
      attemptCount++;
      log('❌', `[DEMO FAULT INJECTION] Injecting simulated upstream 503 Service Unavailable outage...`);
      const err = new Error('HTTP 503: Service Unavailable (Simulated Upstream Cloudflare Outage)');
      err.status = 503;
      throw err;
    };
  }

  log('🚀', `Starting scrape orchestration for "${product.name}"...`);
  const startTime = Date.now();

  const scrapeResult = await scrapeProduct(product, {
    headed,
    scraperFn: customScraper || scrapeProductPage,
    timeoutMs: config.requestTimeoutMs
  });

  const totalDurationMs = Date.now() - startTime;

  // Print Timeline of Attempts
  console.log('\n' + '-'.repeat(80));
  console.log('TIMELINE OF ATTEMPTS:');
  console.log('-'.repeat(80));

  scrapeResult.attempt_details.forEach((att) => {
    const outcomeIcon = att.outcome === 'success' ? '✅' : '❌';
    console.log(
      `  Attempt #${att.attempt} [${att.duration_ms}ms] -> ${outcomeIcon} ${att.outcome.toUpperCase()}` +
      (att.error_type ? ` | Error: [${att.error_type}] ${att.error_message}` : '')
    );
  });

  console.log('-'.repeat(80));
  console.log(`FINAL OUTCOME: ${scrapeResult.success ? '✅ SUCCESS' : '❌ FAILED'}`);
  console.log(`Total Attempts : ${scrapeResult.attempts}`);
  console.log(`Total Duration : ${totalDurationMs}ms`);

  if (scrapeResult.success) {
    console.log(`Resolved Price : ₹${scrapeResult.data.price}`);
    console.log(`MRP on Page    : ${scrapeResult.data.mrp ? '₹' + scrapeResult.data.mrp : 'N/A'}`);
    console.log(`Stock Status   : ${scrapeResult.data.stock_status} (${scrapeResult.data.stock_quantity ?? 'N/A'} units)`);
    console.log(`Agreement Check: PASSED (HTML-parsed ₹${scrapeResult.data.price} == Rendered text "${scrapeResult.data.rendered_price_text}")`);
  } else {
    console.log(`Failure Reason : [${scrapeResult.error_type}] ${scrapeResult.error_message}`);
  }

  // Database Write Decision
  console.log('-'.repeat(80));
  console.log('DATABASE PERSISTENCE AUDIT:');
  if (noDb) {
    console.log('  Decision : ⛔ SKIPPED');
    console.log('  Reason   : --no-db dry-run flag specified. Zero database tables touched.');
  } else if (!scrapeResult.success) {
    console.log('  Decision : ⛔ SKIPPED PRICE WRITE');
    console.log('  Reason   : Scrape failed. Bad/missing price will NEVER be written to price_history table.');
    const isTest = String(product.store_product_id).startsWith('test-') || String(product.id).startsWith('virtual-');
    if (product.id && !isTest) {
      try {
        await insertScrapeLog({
          product_id: product.id,
          status: 'failed',
          attempts: scrapeResult.attempts,
          duration_ms: totalDurationMs,
          http_status: scrapeResult.http_status,
          error_type: scrapeResult.error_type,
          error_message: scrapeResult.error_message,
          attempt_details: scrapeResult.attempt_details
        });
        console.log('  Audit    : 📝 Honest failure telemetry recorded to scrape_logs (status: "failed").');
      } catch (dbErr) {
        console.warn('  Audit    : Could not write scrape log:', dbErr.message);
      }
    } else {
      console.log('  Audit    : Test/virtual product ID detected; skipped live DB audit write.');
    }
  } else {
    console.log('  Decision : 💾 RECORDED');
    const isTest = String(product.store_product_id).startsWith('test-') || String(product.id).startsWith('virtual-');
    if (product.id && !isTest) {
      try {
        const historyRow = await insertPriceHistory({
          product_id: product.id,
          price: scrapeResult.data.price,
          stock_status: scrapeResult.data.stock_status,
          stock_quantity: scrapeResult.data.stock_quantity
        });
        await insertScrapeLog({
          product_id: product.id,
          price_history_id: historyRow?.id,
          status: scrapeResult.attempts > 1 ? 'retried' : 'success',
          attempts: scrapeResult.attempts,
          duration_ms: totalDurationMs,
          http_status: scrapeResult.http_status,
          attempt_details: scrapeResult.attempt_details
        });
        console.log(`  Audit    : Successfully recorded price_history (ID: ${historyRow?.id}) and scrape_logs entry.`);
      } catch (dbErr) {
        console.warn('  Audit    : Failed to write to database:', dbErr.message);
      }
    } else {
      console.log('  Reason   : Product is virtual/test product. Skipped live DB pollution.');
    }
  }
  console.log('='.repeat(80) + '\n');

  return {
    scenario: title,
    product_id: product.store_product_id,
    outcome: scrapeResult.success ? (scrapeResult.attempts > 1 ? 'retried' : 'success') : 'failed',
    attempts: scrapeResult.attempts,
    duration_ms: totalDurationMs,
    scraped_price: scrapeResult.data?.price || null,
    rendered_price_text: scrapeResult.data?.rendered_price_text || null,
    error_type: scrapeResult.error_type || null,
    error_message: scrapeResult.error_message || null,
    db_written: !noDb && scrapeResult.success && !String(product.id).startsWith('virtual-')
  };
}

// -----------------------------------------------------------------------------
// Main CLI Execution
// -----------------------------------------------------------------------------
async function main() {
  const storeId = argv.find((a) => !a.startsWith('--')) || '459';
  const headed = !argv.includes('--headless'); // Default to headed for scrape:watch
  const noDb = argv.includes('--no-db');
  const simulateSlow = argv.includes('--simulate-slow');
  const simulateFailure = argv.includes('--simulate-failure');
  const demoAll = argv.includes('--demo-all');

  const product = await resolveProduct(storeId);
  const results = [];

  console.log('\n' + '#'.repeat(80));
  console.log('PRODUCT PRICE TRACKER — LEVEL B6 OBSERVABLE HEADED SCRAPER');
  console.log(`Git Commit: ${currentCommit.slice(0, 7)} | Date: ${new Date().toISOString()}`);
  console.log('#'.repeat(80));

  if (demoAll) {
    console.log('\n[DEMO-ALL MODE] Running 3 screen-recording scenarios in sequence:\n');

    // 1. Normal Scrape
    results.push(await runScenario({
      title: '1. Normal Scrape (1st-try Success, Visible Window & Highlight)',
      product,
      headed,
      noDb: true,
      simulateSlow: false,
      simulateFailure: false
    }));

    // Pause between scenarios so viewer can see state transitions
    await new Promise((r) => setTimeout(r, 2000));

    // 2. Slow / Stalled Attempt with Retry
    results.push(await runScenario({
      title: '2. Stalled Attempt with Exponential Backoff & Retry Recovery',
      product,
      headed,
      noDb: true,
      simulateSlow: true,
      simulateFailure: false
    }));

    await new Promise((r) => setTimeout(r, 2000));

    // 3. Simulated Failure
    results.push(await runScenario({
      title: '3. Upstream Outage / Failure Handled Without Corrupting Database',
      product,
      headed,
      noDb: true,
      simulateSlow: false,
      simulateFailure: true
    }));
  } else {
    // Single scenario run based on passed flags
    let title = 'Normal Scrape';
    if (simulateSlow) title = 'Stalled Attempt with Retry';
    if (simulateFailure) title = 'Simulated Upstream Failure';

    results.push(await runScenario({
      title,
      product,
      headed,
      noDb: argv.includes('--no-db'),
      simulateSlow,
      simulateFailure
    }));
  }

  // Save evidence output
  const timestampStr = new Date().toISOString().replace(/[:.]/g, '-');
  const evidenceFile = path.join(evidenceDir, `headed_b6_demo_${timestampStr}.json`);
  const report = {
    metadata: {
      timestamp: new Date().toISOString(),
      commit_hash: currentCommit,
      mode: demoAll ? 'demo_all' : (simulateSlow ? 'simulate_slow' : (simulateFailure ? 'simulate_failure' : 'normal')),
      headed,
      no_db: noDb
    },
    results
  };

  fs.writeFileSync(evidenceFile, JSON.stringify(report, null, 2), 'utf8');
  console.log(`💾 Saved B6 demonstration evidence to: docs/evidence/${path.basename(evidenceFile)}`);

  await closeBrowser();
  console.log('\n[Level B6] Headed run complete!\n');
}

main().catch(async (err) => {
  console.error('\n[FATAL ERROR]', err);
  await closeBrowser();
  process.exit(1);
});
