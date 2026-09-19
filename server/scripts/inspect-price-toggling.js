import { getBrowserInstance, closeBrowser } from '../src/services/browserScraper.js';
import config from '../src/config/index.js';

async function inspectRuns() {
  const browser = await getBrowserInstance({ headed: false });
  for (let r = 1; r <= 4; r++) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${config.storeBaseUrl}/product/510`);
    const pb = await page.waitForSelector('.price-block');
    const box = await pb.boundingBox();
    if (box) {
      for (let i = 0; i < 15; i++) {
        await page.mouse.move(box.x + 25 + (i % 4) * 15, box.y + 20);
        await new Promise((res) => setTimeout(res, 60));
      }
    }
    const btn = await page.$('button[aria-label="Reveal price"]');
    if (btn) await btn.click().catch(() => {});
    await page.waitForFunction(() => {
      const el = document.querySelector('.price-block');
      return el && el.classList.contains('price-success');
    }, { timeout: 10000 });

    const data = await page.evaluate(() => {
      const pb = document.querySelector('.price-block');
      const allSpans = Array.from(pb.querySelectorAll('span, div, p')).map((el) => ({
        tag: el.tagName,
        className: el.className,
        text: el.innerText || el.textContent,
        styleDisplay: window.getComputedStyle(el).display,
        ariaHidden: el.getAttribute('aria-hidden')
      }));
      return {
        outerHTML: pb.outerHTML,
        innerText: pb.innerText,
        spans: allSpans.filter((s) => s.text && (s.text.includes('₹') || s.text.includes('Rs')))
      };
    });

    console.log(`\n================ RUN ${r} ===============`);
    console.log('Price block innerText:', JSON.stringify(data.innerText));
    console.log('Price block spans with currency:');
    console.log(JSON.stringify(data.spans, null, 2));
    await context.close();
  }
  await closeBrowser();
}

inspectRuns().catch(async (e) => {
  console.error('Error:', e);
  await closeBrowser();
});
