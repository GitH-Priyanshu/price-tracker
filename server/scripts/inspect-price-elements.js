import { getBrowserInstance, closeBrowser } from '../src/services/browserScraper.js';
import config from '../src/config/index.js';

async function inspectProductPrice(productId) {
  const browser = await getBrowserInstance({ headed: false });
  const context = await browser.newContext();

  const page = await context.newPage();
  await page.goto(`${config.storeBaseUrl}/product/${productId}`, { waitUntil: 'domcontentloaded' });

  // Wait for price container
  const priceBlock = await page.waitForSelector('.price-block');
  const box = await priceBlock.boundingBox();
  for (let i = 0; i < 15; i++) {
    await page.mouse.move(box.x + 25 + (i % 4) * 15, box.y + 20 + (i % 3) * 6);
    await new Promise((r) => setTimeout(r, 60));
  }
  const btn = await page.$('button[aria-label="Reveal price"]');
  if (btn) await btn.click().catch(() => {});

  await page.waitForFunction(() => {
    const el = document.querySelector('.price-block');
    return el && el.classList.contains('price-success');
  }, { timeout: 12000 });

  const priceElements = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('*'));
    const results = [];
    for (const el of all) {
      if (el.children.length > 2) continue; // Leaf or near-leaf elements
      const txt = (el.innerText || el.textContent || '').trim();
      if (txt.includes('₹') || txt.includes('Rs') || /\d+,\d+/.test(txt)) {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        results.push({
          tag: el.tagName,
          className: el.className,
          id: el.id,
          text: txt,
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          ariaHidden: el.getAttribute('aria-hidden'),
          position: { top: Math.round(rect.top), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height) }
        });
      }
    }
    return results;
  });

  console.log(`=== PRICE ELEMENTS FOR PRODUCT ${productId} ===`);
  console.log(JSON.stringify(priceElements, null, 2));

  // Also check product API JSON
  try {
    const res = await fetch(`${config.storeBaseUrl}/api/product/${productId}`);
    const apiData = await res.json();
    console.log(`=== API METADATA FOR PRODUCT ${productId} ===`);
    console.log(JSON.stringify(apiData, null, 2));
  } catch (e) {
    console.log('Error fetching API:', e.message);
  }

  await context.close();
  await closeBrowser();
}

inspectProductPrice('510').catch(async (e) => {
  console.error('Error:', e);
  await closeBrowser();
});
