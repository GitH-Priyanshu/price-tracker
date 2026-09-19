import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const jsonPath = path.resolve(__dirname, '../../docs/evidence/benchmark_comparison_2026-09-19T10-14-40-922Z.json');

const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const runs = data.price_consistency_study.runs;

console.log('================================================================');
console.log('PRICE CONSISTENCY ANALYSIS ACROSS 5 PRODUCTS (5 RUNS EACH)');
console.log('================================================================');

const grouped = {};
for (const r of runs) {
  if (!grouped[r.product_id]) grouped[r.product_id] = [];
  grouped[r.product_id].push(r);
}

for (const [pid, pRuns] of Object.entries(grouped)) {
  console.log(`\n--- PRODUCT ${pid} (${pRuns[0].product_name}) ---`);
  const prices = pRuns.map(r => r.extracted_price);
  console.log('Extracted prices across 5 runs:', prices);
  const uniquePrices = new Set(prices.filter(p => p !== null));
  console.log('Unique prices count:', uniquePrices.size, Array.from(uniquePrices));

  pRuns.forEach((r, idx) => {
    console.log(`  Run ${r.scrape_index}: extracted=${r.extracted_price}`);
    const relevantEls = r.elements_in_dom.filter(e => e.display !== 'none' && (e.className.includes('mr-') || e.className.includes('sl-') || e.className.includes('pv-') || e.tag === 'OUTPUT'));
    relevantEls.forEach(el => {
      console.log(`     <${el.tag} class="${el.className}" opacity="${el.opacity}">: "${el.text}"`);
    });
  });
}
