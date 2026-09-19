import { getBrowserInstance, closeBrowser } from '../src/services/browserScraper.js';
import config from '../src/config/index.js';

async function investigatePrices() {
  const browser = await getBrowserInstance({ headed: false });
  const products = ['510', '985', '989', '520', '383'];
  const results = [];

  for (const pid of products) {
    for (let r = 1; r <= 3; r++) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 }
      });

      // Handle cookie overlay naturally by clicking accept button
      await context.addInitScript(() => {
        const interval = setInterval(() => {
          const btn = document.querySelector('button[aria-label="Accept cookies"]');
          if (btn) btn.click();
        }, 50);
      });

      const page = await context.newPage();
      await page.goto(`${config.storeBaseUrl}/product/${pid}`, { waitUntil: 'domcontentloaded' });

      // Wait for price block
      const pb = await page.waitForSelector('.price-block', { timeout: 6000 });
      const box = await pb.boundingBox();
      if (box) {
        for (let m = 0; m < 15; m++) {
          await page.mouse.move(box.x + 25 + (m % 4) * 15, box.y + 20 + (m % 3) * 6);
          await new Promise((res) => setTimeout(res, 60));
        }
      }

      // Check reveal button and wait until enabled
      try {
        await page.waitForSelector('button[aria-label="Reveal price"]:not([disabled])', { timeout: 3000 });
        const btn = await page.$('button[aria-label="Reveal price"]');
        if (btn) await btn.click();
      } catch (e) {
        // Try fallback click
        const btn = await page.$('button[aria-label="Reveal price"]');
        if (btn) await btn.click().catch(() => {});
      }

      // Wait for success
      await page.waitForFunction(() => {
        const el = document.querySelector('.price-block');
        return el && el.classList.contains('price-success');
      }, { timeout: 12000 });

      // Capture all price-like elements in DOM
      const priceElements = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('*')).filter((el) => {
          if (el.children.length > 2) return false;
          const t = el.innerText || el.textContent || '';
          return t.includes('₹') || t.includes('Rs') || /\b\d{1,3}(?:,\d{3})+\b/.test(t);
        });

        return els.map((el) => {
          const rect = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          return {
            tag: el.tagName,
            className: el.className,
            text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' '),
            display: s.display,
            visibility: s.visibility,
            opacity: s.opacity,
            ariaHidden: el.getAttribute('aria-hidden'),
            position: { top: Math.round(rect.top), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height) }
          };
        });
      });

      const entry = {
        productId: pid,
        runIndex: r,
        priceElements
      };
      results.push(entry);
      console.log(`[Product ${pid} Run ${r}] Found ${priceElements.length} price-like elements:`);
      priceElements.forEach((pe) => {
        console.log(`   <${pe.tag} class="${pe.className}" disp="${pe.display}" opac="${pe.opacity}">: "${pe.text}"`);
      });

      await context.close();
    }
  }

  await closeBrowser();
}

investigatePrices().catch(async (e) => {
  console.error('Error:', e);
  await closeBrowser();
});
