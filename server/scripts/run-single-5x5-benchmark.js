import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import config from '../src/config/index.js';
import { scrapeProduct } from '../src/services/storeClient.js';
import { getBrowserInstance, closeBrowser } from '../src/services/browserScraper.js';
import { parseProductHtml } from '../src/services/parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const evidenceDir = path.resolve(__dirname, '../../docs/evidence');
if (!fs.existsSync(evidenceDir)) {
  fs.mkdirSync(evidenceDir, { recursive: true });
}

const COMMIT_USED = 'c23a1046c98fa01715e63cf5b958de5a99663f61';

async function runSingle5x5() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  console.log('================================================================');
  console.log('SINGLE 5-PRODUCTS x 5-RUNS HEADLESS BENCHMARK (DRY RUN)');
  console.log(`Commit: ${COMMIT_USED.slice(0, 7)}`);
  console.log(`Timestamp: ${timestamp}`);
  console.log('================================================================\n');

  const products = [
    { store_product_id: '510', name: 'Meridian Touch Monitor Two', sku: 'MER-10510' },
    { store_product_id: '985', name: 'Ironwood Monitor Neo', sku: 'IRO-10985' },
    { store_product_id: '989', name: 'Vista Pro Display Neo', sku: 'VIS-10989' },
    { store_product_id: '520', name: 'Vantablack Docking Station Two', sku: 'VAN-10520' },
    { store_product_id: '383', name: 'Ironwood Tote Lite', sku: 'IRO-10383' }
  ];

  const allRuns = [];
  let overallRunIndex = 0;

  for (const product of products) {
    console.log(`\n>>> Testing Product ${product.store_product_id} (${product.name})...`);
    for (let seriesRun = 1; seriesRun <= 5; seriesRun++) {
      overallRunIndex++;
      const start = Date.now();

      let scrapeResult = null;
      try {
        scrapeResult = await scrapeProduct(product, { headed: false });
      } catch (err) {
        scrapeResult = {
          success: false,
          attempts: 1,
          error_type: 'FATAL_ERROR',
          error_message: err.message,
          attempt_details: [{
            attempt: 1,
            outcome: 'failed',
            error_type: 'FATAL_ERROR',
            error_message: err.message
          }]
        };
      }

      const durationMs = Date.now() - start;

      // Extract DOM price elements from rendered page if available
      let domPriceElements = [];
      let selectedElement = null;

      // To capture DOM elements accurately, fetch the page DOM using browserScraper context
      const browser = await getBrowserInstance({ headed: false });
      const diagContext = await browser.newContext();
      try {
        const diagPage = await diagContext.newPage();
        await diagPage.goto(`${config.storeBaseUrl}/product/${product.store_product_id}`, { waitUntil: 'domcontentloaded', timeout: 10000 });
        
        // Check accept cookies
        const cBtn = await diagPage.$('button[aria-label="Accept cookies"]');
        if (cBtn) await cBtn.click().catch(() => {});

        // Move mouse
        const pb = await diagPage.waitForSelector('.price-block', { timeout: 4000 }).catch(() => null);
        if (pb) {
          const box = await pb.boundingBox();
          if (box) {
            for (let i = 0; i < 15; i++) {
              await diagPage.mouse.move(box.x + 25 + (i % 4) * 15, box.y + 20);
              await new Promise(r => setTimeout(r, 50));
            }
          }
          const rBtn = await diagPage.$('button[aria-label="Reveal price"]');
          if (rBtn) await rBtn.click().catch(() => {});
          await diagPage.waitForFunction(() => {
            const el = document.querySelector('.price-block');
            return el && el.classList.contains('price-success');
          }, { timeout: 8000 }).catch(() => {});
        }

        domPriceElements = await diagPage.evaluate(() => {
          const all = Array.from(document.querySelectorAll('*')).filter(el => {
            if (el.children.length > 2) return false;
            const t = el.innerText || el.textContent || '';
            return t.includes('₹') || t.includes('Rs') || /\b\d{1,3}(?:,\d{3})+\b/.test(t);
          });
          return all.map(el => {
            const s = window.getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return {
              tag: el.tagName,
              className: el.className,
              text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' '),
              display: s.display,
              visibility: s.visibility,
              opacity: s.opacity,
              ariaHidden: el.getAttribute('aria-hidden'),
              rect: { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) }
            };
          });
        });

        // Determine which element parser selected
        const rawHtml = await diagPage.content();
        try {
          const parsed = parseProductHtml(rawHtml, product);
          selectedElement = {
            parsed_price: parsed.price,
            extracted_from: domPriceElements.find(e => e.display !== 'none' && !e.className.includes('mr-') && !e.className.includes('sl-') && !e.className.includes('bd-'))?.text || 'active price container'
          };
        } catch {}
      } catch (diagErr) {
        // Diagnosis failure
      } finally {
        await diagContext.close();
      }

      const outcome = scrapeResult.success
        ? (scrapeResult.attempts > 1 ? 'retried' : 'success')
        : 'failed';

      const runRecord = {
        overall_run_number: overallRunIndex,
        product_id: product.store_product_id,
        product_name: product.name,
        sku: product.sku,
        series_run_index: seriesRun,
        outcome,
        attempts: scrapeResult.attempts || 1,
        total_duration_ms: durationMs,
        scraped_price: scrapeResult.data?.price != null ? scrapeResult.data.price : null,
        mrp: scrapeResult.data?.mrp != null ? scrapeResult.data.mrp : null,
        price_mrp_ratio: (scrapeResult.data?.price != null && scrapeResult.data?.mrp != null && scrapeResult.data.mrp > 0)
          ? Number((scrapeResult.data.price / scrapeResult.data.mrp).toFixed(4))
          : null,
        stock_status: scrapeResult.data?.stock_status || null,
        stock_quantity: scrapeResult.data?.stock_quantity ?? null,
        click_or_wait_errors: scrapeResult.attempt_details?.filter(a => a.outcome === 'failed').map(a => ({
          attempt: a.attempt,
          error_type: a.error_type,
          error_message: a.error_message,
          duration_ms: a.duration_ms
        })) || [],
        all_dom_price_elements: domPriceElements,
        selected_element_info: selectedElement,
        parser_commit: COMMIT_USED
      };

      allRuns.push(runRecord);
      console.log(
        `  [Run ${String(overallRunIndex).padStart(2)}/25] Prod ${runRecord.product_id} (#${seriesRun}/5): ` +
        `Outcome=${runRecord.outcome.toUpperCase()} (${runRecord.attempts} att), ` +
        `Price=${runRecord.scraped_price != null ? '₹' + runRecord.scraped_price : 'N/A'}, ` +
        `MRP=${runRecord.mrp != null ? '₹' + runRecord.mrp : 'N/A'} ` +
        `(Ratio=${runRecord.price_mrp_ratio != null ? runRecord.price_mrp_ratio : 'N/A'}), ` +
        `Duration=${durationMs}ms`
      );
    }
  }

  const totalRuns = allRuns.length;
  const firstTrySuccesses = allRuns.filter(r => r.outcome === 'success').length;
  const retriedSuccesses = allRuns.filter(r => r.outcome === 'retried').length;
  const failedRuns = allRuns.filter(r => r.outcome === 'failed').length;
  const stalledRuns = allRuns.filter(r => r.click_or_wait_errors.length > 0 && r.click_or_wait_errors.some(e => e.error_type === 'TIMEOUT'));

  const report = {
    metadata: {
      timestamp,
      commit_used: COMMIT_USED,
      total_runs: totalRuns,
      products_tested: products.length,
      runs_per_product: 5
    },
    summary: {
      total_runs: totalRuns,
      first_try_success_count: firstTrySuccesses,
      first_try_success_rate_percent: Number(((firstTrySuccesses / totalRuns) * 100).toFixed(1)),
      retried_success_count: retriedSuccesses,
      failed_count: failedRuns,
      stalled_runs_count: stalledRuns.length,
      overall_success_rate_percent: Number((((firstTrySuccesses + retriedSuccesses) / totalRuns) * 100).toFixed(1))
    },
    price_variation_analysis: {},
    runs: allRuns
  };

  // Group by product and analyze price variations
  for (const p of products) {
    const pRuns = allRuns.filter(r => r.product_id === p.store_product_id);
    const validPrices = pRuns.map(r => r.scraped_price).filter(pr => pr !== null);
    const uniquePrices = Array.from(new Set(validPrices));
    const runDetails = pRuns.map(r => ({
      series_run: r.series_run_index,
      price: r.scraped_price,
      mrp: r.mrp,
      price_mrp_ratio: r.price_mrp_ratio,
      outcome: r.outcome,
      attempts: r.attempts
    }));
    report.price_variation_analysis[p.store_product_id] = {
      product_name: p.name,
      observed_prices: validPrices,
      unique_prices: uniquePrices,
      has_variation: uniquePrices.length > 1,
      runs: runDetails
    };
  }

  const outputPath = path.join(evidenceDir, `single_5x5_benchmark_${timestamp}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n================================================================`);
  console.log('SINGLE 5x5 BENCHMARK COMPLETE!');
  console.log(`Saved raw JSON evidence to: ${outputPath}`);
  console.log(`First-try success rate: ${report.summary.first_try_success_rate_percent}% (${firstTrySuccesses}/${totalRuns})`);
  console.log(`Stall count: ${stalledRuns.length}`);
  console.log('================================================================\n');

  await closeBrowser();
}

runSingle5x5().catch(async (e) => {
  console.error('Fatal benchmark error:', e);
  await closeBrowser();
});
