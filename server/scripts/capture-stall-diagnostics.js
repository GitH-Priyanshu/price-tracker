import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getBrowserInstance, closeBrowser } from '../src/services/browserScraper.js';
import config from '../src/config/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const evidenceDir = path.resolve(__dirname, '../../docs/evidence');
if (!fs.existsSync(evidenceDir)) {
  fs.mkdirSync(evidenceDir, { recursive: true });
}

async function runStallDiagnostics() {
  console.log('--- REPRODUCING STALLS TO CAPTURE TIMEOUT DIAGNOSTICS ---');
  const products = [
    { id: '120', name: 'Auralite Docking Station Mini' },
    { id: '459', name: 'Domus Sling Plus' },
    { id: '329', name: 'Cobalt Ultrabook Lite' },
    { id: '905', name: 'Vista Monitor Studio' },
    { id: '714', name: 'Nimbus Mechanical Keyboard' }
  ];

  const browser = await getBrowserInstance({ headed: false });
  const diagnosticResults = [];
  let stallCount = 0;

  for (let i = 0; i < products.length * 2 && stallCount < 3; i++) {
    const p = products[i % products.length];
    const url = `${config.storeBaseUrl}/product/${p.id}`;
    console.log(`[Diagnostic Run ${i + 1}] Testing ${p.name} (ID ${p.id})...`);

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    const consoleLogs = [];
    const networkErrors = [];
    const networkResponses = [];

    page.on('console', (msg) => {
      consoleLogs.push({ type: msg.type(), text: msg.text() });
    });
    page.on('requestfailed', (req) => {
      networkErrors.push({
        url: req.url(),
        method: req.method(),
        failure: req.failure()?.errorText
      });
    });
    page.on('response', (res) => {
      networkResponses.push({
        url: res.url(),
        status: res.status()
      });
    });

    const startTime = Date.now();
    let timedOut = false;
    let priceResolved = false;

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });

      // Simulate the current browserScraper logic WITHOUT the cookie overlay fix
      // (Wait only 1200ms for consent button which doesn't match or hasn't appeared yet)
      try {
        const consentBtn = await page.waitForSelector(
          'button:has-text("Accept"), button:has-text("Got it"), .cookie-consent button',
          { timeout: 1200 }
        );
        if (consentBtn) await consentBtn.click();
      } catch {}

      // Wait for price container
      const priceBlock = await page.waitForSelector(
        '.price-block, [class*="priceWrap"], [class*="pw-"]',
        { timeout: 6000 }
      );

      const box = await priceBlock.boundingBox();
      if (box) {
        for (let m = 0; m < 12; m++) {
          await page.mouse.move(box.x + 25 + (m % 4) * 15, box.y + 20 + (m % 3) * 6);
          await new Promise((r) => setTimeout(r, 65));
        }
      }

      // Check reveal button
      const revealBtn = await page.$('button[aria-label="Reveal price"], button:has-text("Reveal price")');
      if (revealBtn) {
        try {
          await revealBtn.click({ timeout: 2000 });
        } catch {}
      }

      // Wait up to 10s for price reveal
      await page.waitForFunction(
        () => {
          const el = document.querySelector('.price-block, [class*="priceWrap"], [class*="pw-"]');
          if (!el) return false;
          const text = el.innerText;
          return (
            !text.includes('Price hidden') &&
            !text.includes('Loading current price') &&
            !text.includes('Retrying') &&
            !text.includes('Hover') &&
            !text.includes('Updating')
          );
        },
        { timeout: 10000 }
      );
      priceResolved = true;
      console.log(`  -> Resolved in ${Date.now() - startTime}ms`);
    } catch (err) {
      timedOut = true;
      stallCount++;
      console.log(`  -> TIMED OUT / STALLED after ${Date.now() - startTime}ms! Capturing diagnostic artifacts...`);

      const screenshotFile = `stall_run_${i + 1}_prod_${p.id}_screenshot.png`;
      const domFile = `stall_run_${i + 1}_prod_${p.id}_dom.html`;

      const screenshotPath = path.join(evidenceDir, screenshotFile);
      await page.screenshot({ path: screenshotPath, fullPage: true });

      const domHtml = await page.content();
      const domPath = path.join(evidenceDir, domFile);
      fs.writeFileSync(domPath, domHtml, 'utf8');

      // Check overlay presence and style
      const overlayInfo = await page.evaluate(() => {
        const overlay = document.querySelector('.cookie-overlay');
        if (!overlay) return { present: false };
        const rect = overlay.getBoundingClientRect();
        const style = window.getComputedStyle(overlay);
        return {
          present: true,
          display: style.display,
          visibility: style.visibility,
          zIndex: style.zIndex,
          pointerEvents: style.pointerEvents,
          rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
        };
      });

      // Check price block status
      const priceBlockInfo = await page.evaluate(() => {
        const el = document.querySelector('.price-block, [class*="priceWrap"], [class*="pw-"]');
        if (!el) return { present: false };
        const btn = el.querySelector('button');
        return {
          present: true,
          className: el.className,
          innerText: el.innerText,
          buttonPresent: !!btn,
          buttonDisabled: btn ? btn.disabled : null,
          buttonText: btn ? btn.innerText : null
        };
      });

      const diag = {
        runIndex: i + 1,
        productId: p.id,
        productName: p.name,
        durationMs: Date.now() - startTime,
        screenshotFile,
        domFile,
        cookieOverlay: overlayInfo,
        priceElement: priceBlockInfo,
        consoleErrors: consoleLogs.filter((l) => l.type === 'error'),
        networkFailures: networkErrors,
        httpErrors: networkResponses.filter((r) => r.status >= 400)
      };

      diagnosticResults.push(diag);
      console.log(`  Diagnostic Summary: Overlay Present=${diag.cookieOverlay.present}, Price State="${diag.priceElement.innerText?.replace(/\n/g, ' ')}", Console Errors=${diag.consoleErrors.length}, HTTP Errors=${diag.httpErrors.length}`);
    } finally {
      await context.close();
    }
  }

  const reportPath = path.join(evidenceDir, 'stall_root_cause_evidence.json');
  fs.writeFileSync(reportPath, JSON.stringify(diagnosticResults, null, 2), 'utf8');
  console.log(`\nDiagnostic capture complete. ${diagnosticResults.length} stalls captured. Evidence saved to ${reportPath}`);

  await closeBrowser();
}

runStallDiagnostics().catch(async (e) => {
  console.error('Fatal diagnostic error:', e);
  await closeBrowser();
});
