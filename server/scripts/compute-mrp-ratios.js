import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const evidenceDir = path.resolve(__dirname, '../../docs/evidence');

const files = fs.readdirSync(evidenceDir).filter((f) => f.endsWith('.json'));

const observations = [];

for (const file of files) {
  const filePath = path.join(evidenceDir, file);
  let content = null;
  try {
    content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    continue;
  }

  // 1. Check single_5x5_benchmark
  if (content.runs && Array.isArray(content.runs)) {
    for (const r of content.runs) {
      const price = r.scraped_price || r.price_inr;
      if (!price) continue;
      // find MRP in all_dom_price_elements
      const mrpEl = r.all_dom_price_elements?.find((el) => el.className?.includes('mr-') || el.text?.includes('₹') && el.opacity === '0.55');
      if (mrpEl) {
        const mrpDigits = mrpEl.text.replace(/[^\d]/g, '');
        const mrp = parseFloat(mrpDigits);
        if (mrp > 0 && price > 0) {
          observations.push({
            file,
            run: r.overall_run_number || r.run_number,
            product_id: r.product_id,
            product_name: r.product_name,
            price,
            mrp,
            ratio: price / mrp
          });
        }
      }
    }
  }

  // 2. Check benchmark_comparison price_consistency_study
  if (content.price_consistency_study?.runs) {
    for (const r of content.price_consistency_study.runs) {
      const price = r.extracted_price;
      if (!price) continue;
      const mrpEl = r.elements_in_dom?.find((el) => el.className?.includes('mr-') || el.text?.includes('₹') && el.opacity === '0.55');
      if (mrpEl) {
        const mrpDigits = mrpEl.text.replace(/[^\d]/g, '');
        const mrp = parseFloat(mrpDigits);
        if (mrp > 0 && price > 0) {
          observations.push({
            file,
            run: r.scrape_index,
            product_id: r.product_id,
            product_name: r.product_name,
            price,
            mrp,
            ratio: price / mrp
          });
        }
      }
    }
  }

  // 3. Check disabled_runs and enabled_runs if DOM elements exist
  if (content.disabled_runs) {
    for (const r of content.disabled_runs) {
      // no DOM elements recorded in disabled_runs summary
    }
  }
}

console.log('================================================================');
console.log(`COMPUTED PRICE/MRP RATIOS ACROSS ALL EVIDENCE FILES (${observations.length} data points)`);
console.log('================================================================\n');

// Filter out obvious parser errors (e.g. 7, 7.92, 8.59) to analyze genuine store price/MRP ratios
const validObs = observations.filter((o) => o.price > 100);
const erroneousObs = observations.filter((o) => o.price <= 100);

console.log(`Valid Scrapes Analyzed: ${validObs.length}`);
console.log(`Parser Error Scrapes (price <= 100): ${erroneousObs.length}`);

const ratios = validObs.map((o) => o.ratio).sort((a, b) => a - b);

const minRatio = ratios[0];
const maxRatio = ratios[ratios.length - 1];
const medianRatio = ratios[Math.floor(ratios.length / 2)];
const avgRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;

console.log('\n--- RATIO SUMMARY FOR VALID SCRAPES ---');
console.log(`Min Price/MRP Ratio:    ${minRatio.toFixed(4)} (${(minRatio * 100).toFixed(2)}%)`);
console.log(`Median Price/MRP Ratio: ${medianRatio.toFixed(4)} (${(medianRatio * 100).toFixed(2)}%)`);
console.log(`Avg Price/MRP Ratio:    ${avgRatio.toFixed(4)} (${(avgRatio * 100).toFixed(2)}%)`);
console.log(`Max Price/MRP Ratio:    ${maxRatio.toFixed(4)} (${(maxRatio * 100).toFixed(2)}%)`);

console.log('\n--- DISTRIBUTION (BINS) ---');
const bins = {
  '< 0.10 (implausible/error)': 0,
  '0.10 - 0.40': 0,
  '0.40 - 0.60': 0,
  '0.60 - 0.80': 0,
  '0.80 - 1.00': 0,
  '> 1.00 (above MRP)': 0
};

for (const o of observations) {
  if (o.ratio < 0.10) bins['< 0.10 (implausible/error)']++;
  else if (o.ratio <= 0.40) bins['0.10 - 0.40']++;
  else if (o.ratio <= 0.60) bins['0.40 - 0.60']++;
  else if (o.ratio <= 0.80) bins['0.60 - 0.80']++;
  else if (o.ratio <= 1.00) bins['0.80 - 1.00']++;
  else bins['> 1.00 (above MRP)']++;
}

console.log(JSON.stringify(bins, null, 2));

console.log('\n--- PARSER ERROR SCRAPES (WOULD BE CAUGHT BY MIN FRACTION) ---');
erroneousObs.forEach((o) => {
  console.log(`  File: ${o.file}, Prod: ${o.product_id} (${o.product_name}) -> Price: ₹${o.price}, MRP: ₹${o.mrp}, Ratio: ${o.ratio.toFixed(6)} (${(o.ratio * 100).toFixed(4)}%)`);
});

console.log('\n--- HIGHEST VALID RATIO OBSERVED ---');
const top5 = [...validObs].sort((a, b) => b.ratio - a.ratio).slice(0, 5);
top5.forEach((o) => {
  console.log(`  Prod ${o.product_id} (${o.product_name}): Price=₹${o.price}, MRP=₹${o.mrp}, Ratio=${o.ratio.toFixed(4)} (${(o.ratio * 100).toFixed(2)}%)`);
});

console.log('\n--- LOWEST VALID RATIO OBSERVED ---');
const bottom5 = [...validObs].sort((a, b) => a.ratio - b.ratio).slice(0, 5);
bottom5.forEach((o) => {
  console.log(`  Prod ${o.product_id} (${o.product_name}): Price=₹${o.price}, MRP=₹${o.mrp}, Ratio=${o.ratio.toFixed(4)} (${(o.ratio * 100).toFixed(2)}%)`);
});
