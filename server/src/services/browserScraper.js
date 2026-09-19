import { chromium } from 'playwright';
import config from '../config/index.js';

let sharedBrowser = null;
let sharedBrowserIsHeaded = false;

let scrapeCount = 0;
const MAX_SCRAPES_BEFORE_RECYCLE = 25;

/**
 * Returns or initializes the shared Chromium browser instance.
 * @param {Object} [options]
 * @param {boolean} [options.headed=false] - If true, launches with visible GUI
 * @returns {Promise<import('playwright').Browser>}
 */
export async function getBrowserInstance(options = {}) {
  const { headed = false } = options;

  if (sharedBrowser && (!sharedBrowser.isConnected() || sharedBrowserIsHeaded !== !!headed || scrapeCount >= MAX_SCRAPES_BEFORE_RECYCLE)) {
    await closeBrowser();
  }

  if (!sharedBrowser) {
    sharedBrowser = await chromium.launch({
      headless: !headed,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        ...(process.platform === 'linux' ? ['--single-process'] : [])
      ]
    });
    sharedBrowserIsHeaded = !!headed;
    scrapeCount = 0;
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
      sharedBrowserIsHeaded = false;
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
  scrapeCount++;
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

    // Check for HTTP errors (4xx, 5xx) immediately
    if (httpStatus >= 400) {
      const html = await page.content().catch(() => '');
      return {
        html,
        httpStatus,
        durationMs: Date.now() - startTime,
        renderedPriceText: null,
        allDomPriceElements: []
      };
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
    let cookieClickError = null;
    try {
      const overlayBtn = await page.$('.cookie-overlay button[aria-label="Accept cookies"]');
      if (overlayBtn) await overlayBtn.click();
    } catch (err) {
      cookieClickError = err.message;
    }

    // Wait for Reveal Price button to become enabled before clicking
    let revealBtnWaitError = null;
    try {
      await page.waitForSelector('button[aria-label="Reveal price"]:not([disabled])', { timeout: 3000 });
    } catch (err) {
      revealBtnWaitError = err.message;
    }

    let revealClickError = null;
    const revealBtn = await page.$('button[aria-label="Reveal price"], button:has-text("Reveal price")');
    if (revealBtn) {
      try {
        await revealBtn.click({ timeout: 2000 });
      } catch (err) {
        revealClickError = err.message;
      }
    } else {
      revealClickError = 'Reveal button not found in DOM';
    }

    // Wait for the visible price element to resolve, placeholder to clear,
    // and price text to remain stable (unchanged for about 500 ms) before capturing
    const elapsedSoFar = Date.now() - startTime;
    const waitTimeoutMs = Math.max(8000, Math.min(timeoutMs - elapsedSoFar, 16000));

    await page.waitForFunction(
      () => {
        const el = document.querySelector('.price-block, [class*="priceWrap"], [class*="pw-"]');
        if (!el) return false;
        const text = (el.innerText || '').trim();
        if (
          !text ||
          text.includes('Price hidden') ||
          text.includes('Loading current price') ||
          text.includes('Retrying') ||
          text.includes('Hover')
        ) {
          return false;
        }

        const now = Date.now();
        if (window.__lastObservedPriceText !== text) {
          window.__lastObservedPriceText = text;
          window.__lastObservedPriceTime = now;
          return false;
        }

        // Ensure price digits have settled and remained unchanged for at least 500ms
        return (now - (window.__lastObservedPriceTime || now)) >= 500;
      },
      { timeout: waitTimeoutMs, polling: 100 }
    ).catch(() => {});

    // In headed mode: visually highlight resolved price and stock elements for screen recording clarity
    if (options.headed) {
      await page.evaluate(() => {
        const pb = document.querySelector('.price-block, .price-main');
        if (pb) {
          pb.style.outline = '3px solid #10b981';
          pb.style.boxShadow = '0 0 16px rgba(16, 185, 129, 0.45)';
          pb.style.borderRadius = '8px';
          pb.style.transition = 'all 0.3s ease';
        }
        const sb = document.querySelector('.stock-badge');
        if (sb) {
          sb.style.outline = '2px solid #3b82f6';
          sb.style.borderRadius = '4px';
        }
      }).catch(() => {});
      await page.waitForTimeout(800).catch(() => {});
    }

    // In the same page state: read the active price element text and all DOM price elements
    let renderedPriceText = null;
    let allDomPriceElements = [];
    try {
      const evalResult = await page.evaluate(() => {
        const container = document.querySelector('.price-main, .price-block, [class*="priceWrap"], [class*="pw-"]');
        let activeText = null;
        if (container) {
          const candidates = container.querySelectorAll('.pv-q9, [class*="pv-"], output, b, span');
          for (const el of candidates) {
            const s = window.getComputedStyle(el);
            if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0' || el.getAttribute('aria-hidden') === 'true') {
              continue;
            }
            if (el.className && (el.className.includes('mr-') || el.className.includes('sl-') || el.className.includes('bd-') || el.className.includes('price-value') || el.className.includes('amount'))) {
              continue;
            }
            const t = (el.innerText || el.textContent || '').trim();
            if (t.includes('₹') || t.includes('Rs') || /\b\d{1,3}(?:,\d{3})+\b/.test(t) || /\b\d{2,}\b/.test(t)) {
              activeText = t;
              break;
            }
          }
          if (!activeText) activeText = container.innerText || null;
        }

        const all = Array.from(document.querySelectorAll('*')).filter(el => {
          if (el.children.length > 2) return false;
          const t = el.innerText || el.textContent || '';
          return t.includes('₹') || t.includes('Rs') || /\b\d{1,3}(?:,\d{3})+\b/.test(t);
        });
        const domElements = all.map(el => {
          const s = window.getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return {
            tag: el.tagName,
            className: el.className,
            text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' '),
            display: s.display,
            visibility: s.visibility,
            opacity: s.opacity,
            ariaHidden: el.getAttribute('aria-hidden'),
            rect: { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) }
          };
        });

        return { activeText, domElements };
      });
      renderedPriceText = evalResult.activeText;
      allDomPriceElements = evalResult.domElements;
    } catch {
      renderedPriceText = null;
      allDomPriceElements = [];
    }

    const html = await page.content();
    const durationMs = Date.now() - startTime;

    return {
      html,
      renderedPriceText,
      allDomPriceElements,
      httpStatus,
      durationMs,
      cookieClickError,
      revealBtnWaitError,
      revealClickError
    };
  } finally {
    // Ensure the isolated context is closed to release all memory
    await context.close().catch(() => {});
  }
}
