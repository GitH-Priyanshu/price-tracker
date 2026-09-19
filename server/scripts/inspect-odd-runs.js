import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const jsonPath = path.resolve(__dirname, '../../docs/evidence/single_5x5_benchmark_2026-09-19T10-31-20-734Z.json');

const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const runs = data.runs;

const targetRuns = [15, 17, 19, 20, 23, 24, 25];

for (const rNum of targetRuns) {
  const r = runs.find((x) => x.overall_run_number === rNum);
  console.log(`\n======================================================`);
  console.log(`RUN ${rNum}: Product ${r.product_id} (${r.product_name}) - Series Run #${r.series_run_index}`);
  console.log(`Scraped Price: ${r.scraped_price}`);
  console.log(`Selected Element Info:`, r.selected_element_info);
  console.log(`Click or Wait Errors:`, r.click_or_wait_errors);
  console.log(`DOM Price Elements:`);
  for (const el of r.all_dom_price_elements) {
    if (el.className.includes('mr-') || el.className.includes('sl-') || el.className.includes('pv-') || el.className.includes('price-value') || el.className.includes('amount') || el.tag === 'OUTPUT') {
      console.log(`  <${el.tag} class="${el.className}" disp="${el.display}" opac="${el.opacity}">: "${el.text}"`);
    }
  }
}
