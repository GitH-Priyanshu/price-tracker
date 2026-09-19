import { getBrowserInstance, closeBrowser } from '../src/services/browserScraper.js';
import config from '../src/config/index.js';

async function test989() {
  const browser = await getBrowserInstance({ headed: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${config.storeBaseUrl}/product/989`);

  // Wait 3 seconds for cookie banner to show
  await page.waitForTimeout(3000);
  const overlay = await page.$('.cookie-overlay');
  console.log('Overlay present at 3s:', !!overlay);

  if (overlay) {
    const btn = await page.$('button[aria-label="Accept cookies"]');
    console.log('Accept button present:', !!btn);
    if (btn) {
      for (let c = 1; c <= 4; c++) {
        const isStillThere = await page.$('.cookie-overlay');
        if (!isStillThere) {
          console.log(`Overlay dismissed after ${c - 1} clicks!`);
          break;
        }
        console.log(`Clicking accept button (click ${c})...`);
        await btn.click().catch((e) => console.log('Click error:', e.message));
        await page.waitForTimeout(300);
      }
    }
  }

  const finalOverlay = await page.$('.cookie-overlay');
  console.log('Overlay still present after clicks?', !!finalOverlay);

  // Now do mouse moves
  const pb = await page.waitForSelector('.price-block');
  const box = await pb.boundingBox();
  for (let i = 0; i < 15; i++) {
    await page.mouse.move(box.x + 25 + (i % 4) * 15, box.y + 20);
    await new Promise((r) => setTimeout(r, 60));
  }

  const rBtn = await page.$('button[aria-label="Reveal price"]');
  if (rBtn) {
    console.log('Reveal button disabled:', await rBtn.isDisabled());
    await rBtn.click().catch(() => {});
  }

  const success = await page.waitForFunction(() => {
    const el = document.querySelector('.price-block');
    return el && el.classList.contains('price-success');
  }, { timeout: 10000 }).then(() => true).catch(() => false);

  console.log('Price revealed successfully:', success);
  if (success) {
    console.log('Price text:', await page.innerText('.price-block'));
  }

  await context.close();
  await closeBrowser();
}

test989().catch(async (e) => {
  console.error('Error:', e);
  await closeBrowser();
});
