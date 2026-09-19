import { getBrowserInstance, closeBrowser } from '../src/services/browserScraper.js';
import config from '../src/config/index.js';

async function diagnoseEventDispatch() {
  const browser = await getBrowserInstance({ headed: false });
  const context = await browser.newContext();

  const page = await context.newPage();
  await page.goto(`${config.storeBaseUrl}/product/510`);

  // Instrument mouse event listener on entire document
  await page.evaluate(() => {
    window.__eventLog = [];
    document.addEventListener('mousemove', (e) => {
      window.__eventLog.push({
        tag: e.target.tagName,
        className: e.target.className,
        x: e.clientX,
        y: e.clientY
      });
    }, true);
  });

  const priceBlock = await page.waitForSelector('.price-block');
  const box = await priceBlock.boundingBox();
  console.log('Price block bounding box:', box);

  for (let i = 0; i < 15; i++) {
    await page.mouse.move(box.x + 25 + (i % 4) * 15, box.y + 20);
    await new Promise((r) => setTimeout(r, 60));
  }

  const events = await page.evaluate(() => window.__eventLog);
  console.log('Total mousemove events recorded:', events.length);
  const targets = {};
  for (const ev of events) {
    const key = `${ev.tag}.${ev.className}`;
    targets[key] = (targets[key] || 0) + 1;
  }
  console.log('Event targets breakdown:', targets);

  // Check if overlay is present
  const overlay = await page.$('.cookie-overlay');
  console.log('Cookie overlay present:', !!overlay);

  // Check price button state
  const btn = await page.$('button[aria-label="Reveal price"]');
  if (btn) {
    console.log('Reveal button disabled:', await btn.isDisabled());
  }

  await context.close();
  await closeBrowser();
}

diagnoseEventDispatch().catch(async (e) => {
  console.error('Error:', e);
  await closeBrowser();
});
