import { chromium } from 'playwright';
import config from '../config/index.js';

let sharedBrowser = null;

/**
 * Returns or initializes the shared Chromium browser instance.
 * @param {Object} [options]
 * @param {boolean} [options.headed=false] - If true, launches with visible GUI
 * @returns {Promise<import('playwright').Browser>}
 */
export async function getBrowserInstance(options = {}) {
  const { headed = false } = options;

  if (sharedBrowser && !sharedBrowser.isConnected()) {
    sharedBrowser = null;
  }

  if (!sharedBrowser) {
    sharedBrowser = await chromium.launch({
      headless: !headed,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ]
    });
  }

  return sharedBrowser;
}

/**
 * Gracefully terminates the shared browser instance.
 */
export async function closeBrowser() {
  if (sharedBrowser) {
    try {
      await sharedBrowser.close();
    } catch (e) {
      // Ignore errors on close
    } finally {
      sharedBrowser = null;
    }
  }
}

/**
 * Navigates to a product detail page, executes the human-like interaction required
 * by the store's anti-bot system, and captures the resolved DOM.
 * 
 * Reuses the single browser instance with a FRESH browser context per scrape.
 * 
 * @param {string} productUrl
 * @param {Object} [options]
 * @param {number} [options.timeout]
 * @param {boolean} [options.headed=false]
 * @returns {Promise<{ html: string, httpStatus: number, durationMs: number }>}
 */
export async function scrapeProductPage(productUrl, options = {}) {
  const timeoutMs = options.timeout || config.requestTimeoutMs;
  const startTime = Date.now();
  const browser = await getBrowserInstance({ headed: options.headed });

  // Fresh isolated context for this scrape
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  });

  // Dismiss cookie modal / overlay by clicking the real accept button as a user would
  // Selector identified from DOM snapshot: button.btn.btn-primary[aria-label="Accept cookies"]
  await context.addInitScript(() => {
    const observer = new MutationObserver(() => {
      const acceptBtn = document.querySelector('.cookie-overlay button[aria-label="Accept cookies"], .cookie-actions button.btn-primary');
      if (acceptBtn) {
        acceptBtn.click();
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  });

  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);

  try {
    // Navigate to product page
    const response = await page.goto(productUrl, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs
    });

    const httpStatus = response ? response.status() : 200;

    // Check for HTTP errors
    if (httpStatus === 404) {
      const html = await page.content();
      return { html, httpStatus, durationMs: Date.now() - startTime };
    }

    // Explicitly click real accept button if present in initial DOM
    try {
      const consentBtn = await page.$(
        '.cookie-overlay button[aria-label="Accept cookies"], .cookie-actions button.btn-primary, button[aria-label="Accept cookies"]'
      );
      if (consentBtn) {
        await consentBtn.click();
      }
    } catch {
      // Modal not present yet, proceed
    }

    // Wait for price container
    const priceBlock = await page.waitForSelector(
      '.price-block, [class*="priceWrap"], [class*="pw-"]',
      { timeout: Math.min(timeoutMs, 6000) }
    );

    // Simulate mouse movement inside priceBlock to satisfy minMoves: 8, minDwellMs: 600
    const box = await priceBlock.boundingBox();
    if (box) {
      for (let i = 0; i < 15; i++) {
        await page.mouse.move(box.x + 25 + (i % 4) * 15, box.y + 20 + (i % 3) * 6);
        await new Promise((r) => setTimeout(r, 65));
      }
    }

    // Click accept cookies if it popped up during dwell
    try {
      const overlayBtn = await page.$('.cookie-overlay button[aria-label="Accept cookies"]');
      if (overlayBtn) await overlayBtn.click();
    } catch {}

    // Wait for Reveal Price button to become enabled before clicking
    try {
      await page.waitForSelector('button[aria-label="Reveal price"]:not([disabled])', { timeout: 3000 });
    } catch {}

    const revealBtn = await page.$('button[aria-label="Reveal price"], button:has-text("Reveal price")');
    if (revealBtn) {
      try {
        await revealBtn.click({ timeout: 2000 });
      } catch {
        // If already triggered by dwell, click might not be required
      }
    }

    // Wait for the visible price element to resolve and placeholder/loading text to clear
    const elapsedSoFar = Date.now() - startTime;
    const waitTimeoutMs = Math.max(8000, Math.min(timeoutMs - elapsedSoFar, 16000));

    await page.waitForFunction(
      () => {
        const el = document.querySelector('.price-block, [class*="priceWrap"], [class*="pw-"]');
        if (!el) return false;
        if (el.classList.contains('price-success')) return true;
        const text = el.innerText;
        return (
          !text.includes('Price hidden') &&
          !text.includes('Loading current price') &&
          !text.includes('Retrying') &&
          !text.includes('Hover')
        );
      },
      { timeout: waitTimeoutMs }
    );

    const html = await page.content();
    const durationMs = Date.now() - startTime;

    return {
      html,
      httpStatus,
      durationMs
    };
  } finally {
    // Ensure the isolated context is closed to release all memory
    await context.close().catch(() => {});
  }
}
