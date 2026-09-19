import { getBrowserInstance, closeBrowser } from '../src/services/browserScraper.js';
import config from '../src/config/index.js';

async function check510() {
  const browser = await getBrowserInstance({ headed: false });
  for (let i = 1; i <= 3; i++) {
    const context = await browser.newContext();
    // Dismiss overlay via button click
    await context.addInitScript(() => {
      setInterval(() => {
        const btn = document.querySelector('.cookie-overlay button[aria-label="Accept cookies"]');
        if (btn) btn.click();
      }, 50);
    });

    const page = await context.newPage();
    await page.goto(`${config.storeBaseUrl}/product/510`);
    const pb = await page.waitForSelector('.price-block');
    const box = await pb.boundingBox();
    if (box) {
      for (let m = 0; m < 15; m++) {
        await page.mouse.move(box.x + 25 + (m % 4) * 15, box.y + 20);
        await new Promise((r) => setTimeout(r, 60));
      }
    }
    const btn = await page.$('button[aria-label="Reveal price"]');
    if (btn) await btn.click().catch(() => {});
    await page.waitForFunction(() => {
      const el = document.querySelector('.price-block');
      return el && el.classList.contains('price-success');
    }, { timeout: 12000 });

    const info = await page.evaluate(() => {
      const el = document.querySelector('.price-main');
      const allText = el ? el.innerText : '';
      const output = document.querySelector('.price-main output');
      const pv = document.querySelector('.price-main [class*="pv-"]');
      const mrp = document.querySelector('.price-main [class*="mr-"]');
      const sale = document.querySelector('.price-main [class*="sl-"]');
      return {
        allText,
        output: output ? output.innerText : null,
        pv: pv ? pv.innerText : null,
        mrp: mrp ? mrp.innerText : null,
        sale: sale ? sale.innerText : null
      };
    });

    console.log(`[Check 510 Run ${i}]`, JSON.stringify(info));
    await context.close();
  }
  await closeBrowser();
}

check510().catch(async (e) => {
  console.error('Error:', e);
  await closeBrowser();
});
