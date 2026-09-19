import { getBrowserInstance, closeBrowser } from '../src/services/browserScraper.js';
import config from '../src/config/index.js';

async function testClickDismissal() {
  const browser = await getBrowserInstance({ headed: false });
  const context = await browser.newContext();

  // Test real button clicking via in-page helper
  await context.addInitScript(() => {
    // Whenever cookie dialog appears, click the real accept button until dismissed
    const interval = setInterval(() => {
      const btn = document.querySelector('.cookie-overlay button[aria-label="Accept cookies"]');
      if (btn) {
        btn.click();
      }
      const overlay = document.querySelector('.cookie-overlay');
      if (!overlay) {
        // Overlay gone, but keep watching in case it pops up later
      }
    }, 50);
  });

  const page = await context.newPage();
  const start = Date.now();
  await page.goto(`${config.storeBaseUrl}/product/985`, { waitUntil: 'domcontentloaded' });
  console.log('Navigated in', Date.now() - start, 'ms');

  // Track mouse moves on price-block
  await page.evaluate(() => {
    window.__movesReceived = 0;
    const el = document.querySelector('.price-block');
    if (el) {
      el.addEventListener('mousemove', () => { window.__movesReceived++; });
    }
  });

  const priceBlock = await page.waitForSelector('.price-block', { timeout: 6000 });
  const box = await priceBlock.boundingBox();
  for (let i = 0; i < 15; i++) {
    await page.mouse.move(box.x + 25 + (i % 4) * 15, box.y + 20 + (i % 3) * 6);
    await new Promise((r) => setTimeout(r, 65));
  }

  const movesCount = await page.evaluate(() => window.__movesReceived);
  console.log('Moves received by price-block:', movesCount);

  const revealBtn = await page.$('button[aria-label="Reveal price"], button:has-text("Reveal price")');
  console.log('Reveal button exists:', !!revealBtn);
  if (revealBtn) {
    const disabled = await revealBtn.isDisabled();
    console.log('Reveal button disabled:', disabled);
    await revealBtn.click({ timeout: 2000 }).catch(e => console.log('Click note:', e.message));
  }

  const resolved = await page.waitForFunction(() => {
    const el = document.querySelector('.price-block');
    return el && el.classList.contains('price-success');
  }, { timeout: 12000 }).then(() => true).catch(() => false);

  console.log('Price resolved:', resolved, 'in', Date.now() - start, 'ms');
  console.log('Final price block text:\n', await page.innerText('.price-block'));

  await context.close();
  await closeBrowser();
}

testClickDismissal().catch(async (e) => {
  console.error('Error:', e);
  await closeBrowser();
});
