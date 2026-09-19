import { getBrowserInstance, closeBrowser } from '../src/services/browserScraper.js';
import config from '../src/config/index.js';

async function testFix() {
  const browser = await getBrowserInstance({ headed: false });
  const products = [
    { id: '120', name: 'Auralite Docking Station Mini' },
    { id: '459', name: 'Domus Sling Plus' },
    { id: '329', name: 'Cobalt Ultrabook Lite' },
    { id: '905', name: 'Vista Monitor Studio' },
    { id: '714', name: 'Nimbus Mechanical Keyboard' }
  ];

  for (const p of products) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    });
    await context.addInitScript(() => {
      const style = document.createElement('style');
      style.innerHTML = '.cookie-overlay, .cookie-banner { display: none !important; pointer-events: none !important; }';
      document.documentElement.appendChild(style);

      // Also observe and auto-dismiss/remove if rendered
      const observer = new MutationObserver(() => {
        const overlay = document.querySelector('.cookie-overlay');
        if (overlay) overlay.remove();
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    });

    const page = await context.newPage();
    const start = Date.now();
    await page.goto(`${config.storeBaseUrl}/product/${p.id}`, { waitUntil: 'domcontentloaded' });
    const navEnd = Date.now();

    const priceBlock = await page.waitForSelector('.price-block', { timeout: 6000 });
    const box = await priceBlock.boundingBox();
    if (box) {
      for (let i = 0; i < 15; i++) {
        await page.mouse.move(box.x + 25 + (i % 4) * 15, box.y + 20 + (i % 3) * 6);
        await new Promise(r => setTimeout(r, 65));
      }
    }

    const revealBtn = await page.$('button[aria-label="Reveal price"], button:has-text("Reveal price")');
    if (revealBtn) {
      await revealBtn.click({ timeout: 2000 }).catch(() => {});
    }

    await page.waitForFunction(() => {
      const el = document.querySelector('.price-block');
      if (!el) return false;
      const txt = el.innerText;
      return !txt.includes('Price hidden') && !txt.includes('Loading') && !txt.includes('Hover');
    }, { timeout: 15000 });

    const total = Date.now() - start;
    const revealDuration = Date.now() - navEnd;
    console.log(`[PASS] Product ${p.id} (${p.name}): Nav=${navEnd - start}ms, Reveal=${revealDuration}ms, Total=${total}ms`);

    await context.close();
  }

  await closeBrowser();
}

testFix().catch(async (e) => {
  console.error('Error:', e);
  await closeBrowser();
});
