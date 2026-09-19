import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const jsonPath = path.resolve(__dirname, '../../docs/evidence/single_5x5_benchmark_2026-09-19T10-31-20-734Z.json');

const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

for (const r of data.runs) {
  if (r.overall_run_number === 17 || r.overall_run_number === 20) {
    console.log(`\n======================================================`);
    console.log(`RUN ${r.overall_run_number}: Product ${r.product_id} (${r.product_name})`);
    console.log(`Scraped Price: ${r.scraped_price}`);
    console.log(`Selected Element Info:`, r.selected_element_info);
    console.log(`Price elements in .price-block or near it:`);
    for (const el of r.all_dom_price_elements) {
      if (['SPAN', 'OUTPUT', 'DIV'].includes(el.tag) && el.text.length < 50) {
        console.log(`  <${el.tag} class="${el.className}" disp="${el.display}" opac="${el.opacity}">: ${JSON.stringify(el.text)}`);
      }
    }
  }
}
