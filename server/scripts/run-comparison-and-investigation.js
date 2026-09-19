import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import config from '../src/config/index.js';
import { getBrowserInstance, closeBrowser } from '../src/services/browserScraper.js';
import { parseProductHtml } from '../src/services/parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const evidenceDir = path.resolve(__dirname, '../../docs/evidence');
if (!fs.existsSync(evidenceDir)) {
  fs.mkdirSync(evidenceDir, { recursive: true });
}

function getProcessTreeMemoryBytes(rootPid = process.pid) {
  try {
    const psCmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, WorkingSetSize | ConvertTo-Json -Compress"`;
    const stdout = execSync(psCmd, { encoding: 'utf8', timeout: 5000 });
    const procs = JSON.parse(stdout);
    const pids = new Set([rootPid]);
    let added = true;
    while (added) {
      added = false;
      for (const p of procs) {
        if (pids.has(p.ParentProcessId) && !pids.has(p.ProcessId)) {
          pids.add(p.ProcessId);
          added = true;
        }
      }
    }
    let totalWorkingSet = 0;
    const matched = [];
    for (const p of procs) {
      if (pids.has(p.ProcessId)) {
        const ws = Number(p.WorkingSetSize) || 0;
        totalWorkingSet += ws;
        matched.push({ pid: p.ProcessId, wsMb: (ws / (1024 * 1024)).toFixed(1) });
      }
    }
    return { totalBytes: totalWorkingSet, totalMb: Number((totalWorkingSet / (1024 * 1024)).toFixed(1)), processes: matched };
  } catch (e) {
    const rss = process.memoryUsage().rss;
    return { totalBytes: rss, totalMb: Number((rss / (1024 * 1024)).toFixed(1)), error: e.message };
  }
}

async function scrapeSingle(product, options = {}) {
  const { enableFix = true, timeoutMs = 12000 } = options;
  const browser = await getBrowserInstance({ headed: false });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  });

  if (enableFix) {
    // Natural button click on the real accept button
    await context.addInitScript(() => {
      const observer = new MutationObserver(() => {
        const acceptBtn = document.querySelector('.cookie-overlay button[aria-label="Accept cookies"], .cookie-actions button.btn-primary');
        if (acceptBtn) acceptBtn.click();
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    });
  }

  const page = await context.newPage();
  const start = Date.now();
  let timedOut = false;
  let rawHtml = '';
  let priceElements = [];
  let overlayAtTimeout = null;
  let targetEventsReceived = 0;

  try {
    await page.goto(`${config.storeBaseUrl}/product/${product.store_product_id}`, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs
    });

    if (enableFix) {
      try {
        const consentBtn = await page.$('.cookie-overlay button[aria-label="Accept cookies"], button[aria-label="Accept cookies"]');
        if (consentBtn) await consentBtn.click();
      } catch {}
    }

    const priceBlock = await page.waitForSelector('.price-block, [class*="priceWrap"]', { timeout: 6000 });
    const box = await priceBlock.boundingBox();
    if (box) {
      for (let i = 0; i < 15; i++) {
        await page.mouse.move(box.x + 25 + (i % 4) * 15, box.y + 20 + (i % 3) * 6);
        await new Promise((r) => setTimeout(r, 65));
      }
    }

    if (enableFix) {
      try {
        const overlayBtn = await page.$('.cookie-overlay button[aria-label="Accept cookies"]');
        if (overlayBtn) await overlayBtn.click();
      } catch {}

      try {
        await page.waitForSelector('button[aria-label="Reveal price"]:not([disabled])', { timeout: 3000 });
      } catch {}
    }

    const revealBtn = await page.$('button[aria-label="Reveal price"], button:has-text("Reveal price")');
    if (revealBtn) {
      try {
        await revealBtn.click({ timeout: 2000 });
      } catch {}
    }

    await page.waitForFunction(() => {
      const el = document.querySelector('.price-block');
      if (!el) return false;
      if (el.classList.contains('price-success')) return true;
      const t = el.innerText;
      return !t.includes('Price hidden') && !t.includes('Loading') && !t.includes('Retrying') && !t.includes('Hover');
    }, { timeout: timeoutMs });

    rawHtml = await page.content();
  } catch (err) {
    timedOut = true;
    rawHtml = await page.content();
    overlayAtTimeout = await page.evaluate(() => {
      const el = document.querySelector('.cookie-overlay');
      if (!el) return { present: false };
      const s = window.getComputedStyle(el);
      return { present: true, display: s.display, zIndex: s.zIndex, pointerEvents: s.pointerEvents };
    });
  }

  // Extract all price-like elements in DOM
  priceElements = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('*')).filter((el) => {
      if (el.children.length > 2) return false;
      const t = el.innerText || el.textContent || '';
      return t.includes('₹') || t.includes('Rs') || /\b\d{1,3}(?:,\d{3})+\b/.test(t);
    });
    return els.map((el) => {
      const s = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        className: el.className,
        text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' '),
        display: s.display,
        opacity: s.opacity,
        ariaHidden: el.getAttribute('aria-hidden'),
        rect: { top: Math.round(rect.top), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height) }
      };
    });
  });

  const durationMs = Date.now() - start;
  let parsed = null;
  let parseError = null;
  if (!timedOut) {
    try {
      parsed = parseProductHtml(rawHtml, product);
    } catch (pe) {
      parseError = pe.message;
    }
  }

  await context.close();

  return {
    productId: product.store_product_id,
    productName: product.name,
    sku: product.sku,
    timedOut,
    durationMs,
    parsedPrice: parsed ? parsed.price : null,
    stockStatus: parsed ? parsed.stock_status : null,
    stockQuantity: parsed ? parsed.stock_quantity : null,
    priceElements,
    overlayAtTimeout,
    parseError
  };
}

async function runFullComparison() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  console.log('================================================================');
  console.log('BENCHMARK: 20 SCRAPES FIX DISABLED vs 20 SCRAPES FIX ENABLED');
  console.log(`Timestamp: ${timestamp}`);
  console.log('================================================================\n');

  const products = [
    { store_product_id: '510', name: 'Meridian Touch Monitor Two', sku: 'MER-10510' },
    { store_product_id: '985', name: 'Ironwood Monitor Neo', sku: 'IRO-10985' },
    { store_product_id: '989', name: 'Vista Pro Display Neo', sku: 'VIS-10989' },
    { store_product_id: '520', name: 'Vantablack Docking Station Two', sku: 'VAN-10520' },
    { store_product_id: '383', name: 'Ironwood Tote Lite', sku: 'IRO-10383' }
  ];

  let peakTreeMb = 0;

  // 1. Run 20 scrapes with fix DISABLED
  console.log('>>> [BATCH 1] Running 20 Scrapes with Overlay Fix DISABLED...');
  const disabledRuns = [];
  for (let r = 1; r <= 4; r++) {
    for (let pIdx = 0; pIdx < products.length; pIdx++) {
      const prod = products[pIdx];
      const res = await scrapeSingle(prod, { enableFix: false, timeoutMs: 12000 });
      const treeMem = getProcessTreeMemoryBytes();
      if (treeMem.totalMb > peakTreeMb) peakTreeMb = treeMem.totalMb;
      res.runNumber = disabledRuns.length + 1;
      res.processTreeMb = treeMem.totalMb;
      disabledRuns.push(res);
      console.log(`  [Disabled Run ${String(res.runNumber).padStart(2)}/20] Prod ${res.productId}: TimedOut=${res.timedOut}, Duration=${res.durationMs}ms, Price=${res.parsedPrice}, TreeMem=${res.processTreeMb}MB`);
    }
  }

  // 2. Run 20 scrapes with fix ENABLED
  console.log('\n>>> [BATCH 2] Running 20 Scrapes with Overlay Fix ENABLED...');
  const enabledRuns = [];
  for (let r = 1; r <= 4; r++) {
    for (let pIdx = 0; pIdx < products.length; pIdx++) {
      const prod = products[pIdx];
      const res = await scrapeSingle(prod, { enableFix: true, timeoutMs: 12000 });
      const treeMem = getProcessTreeMemoryBytes();
      if (treeMem.totalMb > peakTreeMb) peakTreeMb = treeMem.totalMb;
      res.runNumber = enabledRuns.length + 1;
      res.processTreeMb = treeMem.totalMb;
      enabledRuns.push(res);
      console.log(`  [Enabled Run  ${String(res.runNumber).padStart(2)}/20] Prod ${res.productId}: TimedOut=${res.timedOut}, Duration=${res.durationMs}ms, Price=${res.parsedPrice}, TreeMem=${res.processTreeMb}MB`);
    }
  }

  // 3. Price Consistency: 5 products x 5 scrapes each in quick succession with fix enabled
  console.log('\n>>> [BATCH 3] Price Consistency: 5 Products x 5 Scrapes Each...');
  const consistencyRuns = [];
  for (const prod of products) {
    for (let i = 1; i <= 5; i++) {
      const res = await scrapeSingle(prod, { enableFix: true, timeoutMs: 12000 });
      const treeMem = getProcessTreeMemoryBytes();
      if (treeMem.totalMb > peakTreeMb) peakTreeMb = treeMem.totalMb;
      res.seriesRun = i;
      res.processTreeMb = treeMem.totalMb;
      consistencyRuns.push(res);
      console.log(`  [Consistency] Prod ${prod.store_product_id} (#${i}/5): Price=${res.parsedPrice}, Duration=${res.durationMs}ms`);
    }
  }

  const disabledStalls = disabledRuns.filter(r => r.timedOut).length;
  const enabledStalls = enabledRuns.filter(r => r.timedOut).length;

  const comparisonReport = {
    metadata: {
      timestamp,
      total_runs_per_batch: 20,
      target_products: products.length
    },
    stall_comparison: {
      fix_disabled: {
        total_runs: 20,
        stalled_count: disabledStalls,
        success_count: 20 - disabledStalls,
        stall_rate_percent: Number(((disabledStalls / 20) * 100).toFixed(1))
      },
      fix_enabled: {
        total_runs: 20,
        stalled_count: enabledStalls,
        success_count: 20 - enabledStalls,
        stall_rate_percent: Number(((enabledStalls / 20) * 100).toFixed(1))
      }
    },
    memory_summary: {
      peak_process_tree_mb: peakTreeMb,
      description: "Whole process tree working set (Node process + Chromium child processes)"
    },
    disabled_runs: disabledRuns.map(r => ({
      run_number: r.runNumber,
      product_id: r.productId,
      product_name: r.productName,
      timed_out: r.timedOut,
      duration_ms: r.durationMs,
      price: r.parsedPrice,
      process_tree_mb: r.processTreeMb,
      overlay_present: r.overlayAtTimeout ? r.overlayAtTimeout.present : false
    })),
    enabled_runs: enabledRuns.map(r => ({
      run_number: r.runNumber,
      product_id: r.productId,
      product_name: r.productName,
      timed_out: r.timedOut,
      duration_ms: r.durationMs,
      price: r.parsedPrice,
      process_tree_mb: r.processTreeMb
    })),
    price_consistency_study: {
      description: "5 products scraped 5 times each in quick succession",
      runs: consistencyRuns.map(r => ({
        product_id: r.productId,
        product_name: r.productName,
        scrape_index: r.seriesRun,
        extracted_price: r.parsedPrice,
        stock_status: r.stockStatus,
        stock_quantity: r.stockQuantity,
        duration_ms: r.durationMs,
        elements_in_dom: r.priceElements
      }))
    }
  };

  const outFile = path.join(evidenceDir, `benchmark_comparison_${timestamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify(comparisonReport, null, 2), 'utf8');
  console.log(`\n================================================================`);
  console.log(`FULL COMPARISON & INVESTIGATION COMPLETED!`);
  console.log(`Evidence saved to: ${outFile}`);
  console.log(`Stall Comparison:`);
  console.log(`  Fix DISABLED: ${disabledStalls}/20 Stalled (${comparisonReport.stall_comparison.fix_disabled.stall_rate_percent}%)`);
  console.log(`  Fix ENABLED:  ${enabledStalls}/20 Stalled (${comparisonReport.stall_comparison.fix_enabled.stall_rate_percent}%)`);
  console.log(`Peak Process Tree Memory: ${peakTreeMb} MB`);
  console.log(`================================================================\n`);

  await closeBrowser();
}

runFullComparison().catch(async (e) => {
  console.error('Fatal comparison error:', e);
  await closeBrowser();
});
