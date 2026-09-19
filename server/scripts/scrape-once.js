import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import config from '../src/config/index.js';
import { scrapeProduct } from '../src/services/storeClient.js';
import { closeBrowser } from '../src/services/browserScraper.js';
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
 * Creates an ephemeral local HTTP stub server to serve demo faults (real 503s or slow delay)
 * through the actual Playwright browser network client path.
 */
function createFaultStubServer({ mode, originalUrl, storeId }) {
  let productNavCount = 0;
  const server = http.createServer(async (req, res) => {
    const isProductNav = req.url.startsWith(`/product/${storeId}`);
    if (isProductNav) {
      productNavCount++;
    }

    if (mode === 'simulate_failure') {
      // Real HTTP 503 Service Unavailable response
      res.writeHead(503, {
        'Content-Type': 'text/html; charset=utf-8',
        'Retry-After': '2'
      });
      res.end('<!DOCTYPE html><html><head><title>503 Service Unavailable</title></head><body><h1>503 Service Unavailable</h1><p>Demo Fault Injection: Upstream Gateway Down</p></body></html>');
      return;
    }

    if (mode === 'simulate_slow') {
      if (isProductNav && productNavCount === 1) {
        // Hold connection open for 13,000ms to trigger client-side Playwright timeout (12s)
        await new Promise((r) => setTimeout(r, 13000));
        if (!res.writableEnded) {
          res.writeHead(504, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>Gateway Timeout</h1>');
        }
        return;
      }

      // On attempt 2+: redirect browser to real upstream mock store
      res.writeHead(307, { Location: originalUrl });
      res.end();
      return;
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const stubUrl = `http://127.0.0.1:${port}/product/${storeId}`;
      resolve({
        stubUrl,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
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
  console.log(`Browser Mode   : ${headed ? 'HEADED (Visible Chromium GUI Window)' : 'HEADLESS'}`);
  console.log(`DB Mode        : ${noDb ? 'DRY RUN (--no-db active: zero database writes)' : 'LIVE DB PERSISTENCE'}`);
  console.log(`Fault Injection: ${
    simulateSlow ? 'SIMULATE-SLOW (Local stub server stalls Attempt 1 for 13s, then recovers)' :
    simulateFailure ? 'SIMULATE-FAILURE (Local stub server returns real HTTP 503 across all attempts)' :
    'NONE (Standard Production Pipeline against Mock Store)'
  }`);
  console.log('-'.repeat(80));

  let stubServer = null;
  let targetProduct = product;

  if (simulateSlow) {
    stubServer = await createFaultStubServer({
      mode: 'simulate_slow',
      originalUrl: product.url,
      storeId: product.store_product_id
    });
    targetProduct = { ...product, url: stubServer.stubUrl };
    log('⏳', `[Demo Fault Stub Server] Serving simulated slow network on ${stubServer.stubUrl}`);
  } else if (simulateFailure) {
    stubServer = await createFaultStubServer({
      mode: 'simulate_failure',
      originalUrl: product.url,
      storeId: product.store_product_id
    });
    targetProduct = { ...product, url: stubServer.stubUrl };
    log('❌', `[Demo Fault Stub Server] Serving real HTTP 503 outage on ${stubServer.stubUrl}`);
  }

  log('🚀', `Starting scrape orchestration for "${product.name}"...`);
  const startTime = Date.now();

  try {
    const scrapeResult = await scrapeProduct(targetProduct, {
      headed,
      timeoutMs: config.requestTimeoutMs,
      onBackoffWait: (waitMs, nextAttempt) => {
        log('⏱️', `waiting ${(waitMs / 1000).toFixed(1)} s before attempt ${nextAttempt}`);
      }
    });

    const totalDurationMs = Date.now() - startTime;

    // Print Timeline of Attempts
    console.log('\n' + '-'.repeat(80));
    console.log('TIMELINE OF ATTEMPTS:');
    console.log('-'.repeat(80));

    scrapeResult.attempt_details.forEach((att, idx) => {
      const outcomeIcon = att.outcome === 'success' ? '✅' : '❌';
      console.log(
        `  Attempt #${att.attempt} [${att.duration_ms}ms] -> ${outcomeIcon} ${att.outcome.toUpperCase()}` +
        (att.error_type ? ` | Error: [${att.error_type}] ${att.error_message}` : '')
      );
      if (att.backoff_wait_ms && idx < scrapeResult.attempt_details.length - 1) {
        console.log(`  -> waiting ${(att.backoff_wait_ms / 1000).toFixed(1)} s before attempt ${att.attempt + 1}`);
      }
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
  } finally {
    if (stubServer) {
      await stubServer.close().catch(() => {});
    }
  }
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
    let title = 'Normal Scrape';
    if (simulateSlow) title = 'Stalled Attempt with Retry';
    if (simulateFailure) title = 'Simulated Upstream Failure';

    results.push(await runScenario({
      title,
      product,
      headed,
      noDb,
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
