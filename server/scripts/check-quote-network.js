import { getBrowserInstance, closeBrowser } from '../src/services/browserScraper.js';
import config from '../src/config/index.js';

async function checkQuotes() {
  const browser = await getBrowserInstance({ headed: false });
  const context = await browser.newContext();

  // Natural button click observer for cookie overlay
  await context.addInitScript(() => {
    setInterval(() => {
      const btn = document.querySelector('.cookie-overlay button[aria-label="Accept cookies"]');
      if (btn) btn.click();
    }, 40);
  });

  const page = await context.newPage();

  const quotes = [];
  page.on('response', async (res) => {
    if (res.url().includes('/api/products/510/price') && res.status() === 200) {
      try {
        const json = await res.json();
        quotes.push(json);
      } catch {}
    }
  });

  for (let k = 0; k < 5; k++) {
    await page.goto(`${config.storeBaseUrl}/product/510`);
    const pb = await page.waitForSelector('.price-block');
    const box = await pb.boundingBox();
    if (box) {
      for (let i = 0; i < 15; i++) {
        await page.mouse.move(box.x + 25 + (i % 4) * 15, box.y + 20);
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    const rBtn = await page.$('button[aria-label="Reveal price"]');
    if (rBtn) await rBtn.click().catch(() => {});
    await page.waitForFunction(() => {
      const el = document.querySelector('.price-block');
      return el && el.classList.contains('price-success');
    }, { timeout: 10000 });

    const innerTxt = await page.innerText('.price-block');
    const resolvedPrice = await page.evaluate(() => {
      const out = document.querySelector('.price-main output, .price-main [class*="pv-"]');
      return out ? out.innerText : null;
    });
    console.log(`[Run ${k + 1}] output/pv text: "${resolvedPrice}"`);
  }

  console.log('Intercepted quotes count:', quotes.length);
  await context.close();
  await closeBrowser();
}

checkQuotes().catch(async (e) => {
  console.error('Error:', e);
  await closeBrowser();
});
