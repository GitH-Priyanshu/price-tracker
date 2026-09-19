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

    // Dismiss cookie modal if present
    try {
      const consentBtn = await page.waitForSelector(
        'button:has-text("Accept"), button:has-text("Got it"), .cookie-consent button',
        { timeout: 1200 }
      );
      if (consentBtn) {
        await consentBtn.click();
      }
    } catch {
      // Modal not present, proceed
    }

    // Wait for price container
    const priceBlock = await page.waitForSelector(
      '.price-block, [class*="priceWrap"], [class*="pw-"]',
      { timeout: Math.min(timeoutMs, 6000) }
    );

    // Simulate mouse movement inside priceBlock to satisfy minMoves: 8, minDwellMs: 600
    const box = await priceBlock.boundingBox();
    if (box) {
      for (let i = 0; i < 12; i++) {
        await page.mouse.move(box.x + 25 + (i % 4) * 15, box.y + 20 + (i % 3) * 6);
        await new Promise((r) => setTimeout(r, 65));
      }
    }

    // Check for Reveal Price button and click once enabled
    const revealBtn = await page.$('button[aria-label="Reveal price"], button:has-text("Reveal price")');
    if (revealBtn) {
      const isDisabled = await revealBtn.isDisabled();
      if (isDisabled) {
        // Add extra dwell movements if button still disabled
        if (box) {
          for (let j = 0; j < 8; j++) {
            await page.mouse.move(box.x + 30 + j * 5, box.y + 25 + (j % 2) * 5);
            await new Promise((r) => setTimeout(r, 80));
          }
        }
      }
      try {
        await revealBtn.click({ timeout: 2000 });
      } catch {
        // If already triggered by hover, click might not be required
      }
    }

    // Wait for the visible price element to resolve and placeholder/loading text to clear
    // Use remaining attempt budget (up to 16s headroom) instead of a tight 10s ceiling
    const elapsedSoFar = Date.now() - startTime;
    const waitTimeoutMs = Math.max(8000, Math.min(timeoutMs - elapsedSoFar, 16000));

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
