import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  parsePriceText,
  parseStockText,
  parseProductHtml,
  normalizeUnicodeDigits,
  ParseError
} from '../src/services/parser.js';
import { validateScrapedProduct, ValidationError } from '../src/services/validator.js';
import { scrapeProduct, searchProducts, classifyError } from '../src/services/storeClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');

// Load fixtures
const normalHtml = fs.readFileSync(path.join(FIXTURES_DIR, 'product_normal_revealed.html'), 'utf8');
const placeholderHtml = fs.readFileSync(path.join(FIXTURES_DIR, 'product_loading_placeholder.html'), 'utf8');
const errorPageHtml = fs.readFileSync(path.join(FIXTURES_DIR, 'product_error_page.html'), 'utf8');
const structureShiftHtml = fs.readFileSync(path.join(FIXTURES_DIR, 'product_structure_shift.html'), 'utf8');

test('Price Text Sanitization & Robust Parsing', async (t) => {
  await t.test('normalizes full-width unicode digits', () => {
    assert.equal(normalizeUnicodeDigits('６７２７'), '6727');
    assert.equal(normalizeUnicodeDigits('₹１２３４.５０'), '₹1234.50');
  });

  await t.test('parses standard Indian currency formatted text', () => {
    assert.equal(parsePriceText('₹6,727'), 6727);
    assert.equal(parsePriceText('Rs. 6,727.00'), 6727);
    assert.equal(parsePriceText('₹9,475/- (incl. of all taxes)'), 9475);
  });

  await t.test('parses spaced number formatting', () => {
    assert.equal(parsePriceText('₹ 6 727'), 6727);
    assert.equal(parsePriceText('6 727.50'), 6727.5);
  });

  await t.test('parses unambiguous euro comma decimal formatting', () => {
    assert.equal(parsePriceText('6.727,00'), 6727);
    assert.equal(parsePriceText('1.250,50'), 1250.5);
    assert.equal(parsePriceText('₹7.493,00'), 7493);
  });

  await t.test('rejects ambiguous price strings (e.g. single dot with 3 digits) to trigger retry', () => {
    assert.throws(() => parsePriceText('₹61.925'), (err) => {
      assert.equal(err.errorType, 'PARSE_ERROR');
      assert.match(err.message, /Ambiguous price format/);
      return true;
    });
    assert.throws(() => parsePriceText('₹7.493'), (err) => {
      assert.equal(err.errorType, 'PARSE_ERROR');
      return true;
    });
    assert.throws(() => parsePriceText('61.925'), (err) => {
      assert.equal(err.errorType, 'PARSE_ERROR');
      return true;
    });
  });

  await t.test('strips zero-width and invisible noise characters', () => {
    const obfuscated = '₹\u200B6\u200B,\u200B7\u200B2\u200B7';
    assert.equal(parsePriceText(obfuscated), 6727);
  });

  await t.test('rejects placeholder / loading phrases with PLACEHOLDER error', () => {
    assert.throws(() => parsePriceText('Price hidden'), (err) => {
      assert.equal(err.errorType, 'PLACEHOLDER');
      return true;
    });
    assert.throws(() => parsePriceText('Loading current price…'), (err) => {
      assert.equal(err.errorType, 'PLACEHOLDER');
      return true;
    });
    assert.throws(() => parsePriceText('Updating…'), (err) => {
      assert.equal(err.errorType, 'PLACEHOLDER');
      return true;
    });
  });

  await t.test('rejects empty or invalid prices', () => {
    assert.throws(() => parsePriceText(''), /missing or empty/);
    assert.throws(() => parsePriceText('N/A'), /Failed to extract numeric price/);
    assert.throws(() => parsePriceText('₹0.00'), /invalid non-positive price/);
  });
});

test('Stock Text Parsing', async (t) => {
  await t.test('parses "In stock · 100 left"', () => {
    const res = parseStockText('In stock · 100 left', 'stock-badge in-stock');
    assert.equal(res.stock_status, 'in_stock');
    assert.equal(res.stock_quantity, 100);
  });

  await t.test('parses "Only 5 left"', () => {
    const res = parseStockText('Only 5 left', 'in-stock');
    assert.equal(res.stock_status, 'in_stock');
    assert.equal(res.stock_quantity, 5);
  });

  await t.test('parses "Out of stock"', () => {
    const res = parseStockText('Out of stock', 'stock-badge out-stock');
    assert.equal(res.stock_status, 'out_of_stock');
    assert.equal(res.stock_quantity, 0);
  });
});

test('HTML DOM Parser Against Fixtures', async (t) => {
  const meta = { store_product_id: '459', name: 'Domus Sling Plus' };

  await t.test('normal revealed DOM extracts price and stock while ignoring decoy elements', () => {
    const parsed = parseProductHtml(normalHtml, meta);
    assert.equal(parsed.store_product_id, '459');
    assert.equal(parsed.name, 'Domus Sling Plus');
    // Real price is 6727, not the decoy 7854 or 4040
    assert.equal(parsed.price, 6727);
    assert.equal(parsed.stock_status, 'in_stock');
    assert.equal(parsed.stock_quantity, 100);
  });

  await t.test('ignores Deal price (sl-*) and decoys to extract active price from split-carrier span', () => {
    const htmlWithDealPrice = `
      <h1>Domus Sling Plus</h1>
      <div class="price-main">
        <span class="price-value" style="display: none;" aria-hidden="true">₹99,999</span>
        <span class="mr-m4" style="text-decoration: line-through;">₹21,532</span>
        <span class="sl-m4">Deal price ₹16,795</span>
        <span class="v0 pv-m4" style="font-size: 2.4rem;"><span>₹​</span><span>1​</span><span>2​</span><span>,​</span><span>0​</span><span>5​</span><span>8​</span></span>
        <span class="bd-m4">44% off</span>
      </div>
      <span class="stock-badge in-stock">In stock · 50 left</span>
    `;
    const parsed = parseProductHtml(htmlWithDealPrice, meta);
    assert.equal(parsed.price, 12058); // Must be real selling price 12058, NOT deal price 16795
    assert.equal(parsed.stock_quantity, 50);
  });

  await t.test('loading/placeholder DOM throws PLACEHOLDER error', () => {
    assert.throws(() => parseProductHtml(placeholderHtml, meta), (err) => {
      assert.equal(err.errorType, 'PLACEHOLDER');
      return true;
    });
  });

  await t.test('error 404 DOM throws HTTP_4XX error', () => {
    assert.throws(() => parseProductHtml(errorPageHtml, meta), (err) => {
      assert.equal(err.errorType, 'HTTP_4XX');
      return true;
    });
  });

  await t.test('structure shift / missing element DOM throws PARSE_ERROR', () => {
    assert.throws(() => parseProductHtml(structureShiftHtml, meta), (err) => {
      assert.equal(err.errorType, 'PARSE_ERROR');
      return true;
    });
  });
});

test('Validator Strict Data Integrity Rules', async (t) => {
  const expected = { store_product_id: '459', name: 'Domus Sling Plus' };

  await t.test('valid scraped product passes', () => {
    const scraped = {
      store_product_id: '459',
      name: 'Domus Sling Plus',
      price: 6727,
      stock_status: 'in_stock',
      stock_quantity: 100
    };
    assert.equal(validateScrapedProduct(scraped, expected), true);
  });

  await t.test('rejects zero or negative price with VALIDATION', () => {
    assert.throws(
      () => validateScrapedProduct({ ...expected, price: 0, stock_status: 'in_stock' }, expected),
      (err) => err.errorType === 'VALIDATION'
    );
    assert.throws(
      () => validateScrapedProduct({ ...expected, price: -10, stock_status: 'in_stock' }, expected),
      (err) => err.errorType === 'VALIDATION'
    );
  });

  await t.test('rejects unknown stock status with VALIDATION', () => {
    assert.throws(
      () => validateScrapedProduct({ ...expected, price: 500, stock_status: 'maybe_in_stock' }, expected),
      (err) => err.errorType === 'VALIDATION'
    );
  });

  await t.test('rejects empty product name with VALIDATION', () => {
    assert.throws(
      () => validateScrapedProduct({ store_product_id: '459', name: '  ', price: 500, stock_status: 'in_stock' }, expected),
      (err) => err.errorType === 'VALIDATION'
    );
  });

  await t.test('rejects identity mismatch (wrong product) with IDENTITY_MISMATCH', () => {
    assert.throws(
      () => validateScrapedProduct({ store_product_id: '999', name: 'Other Item', price: 500, stock_status: 'in_stock' }, expected),
      (err) => err.errorType === 'IDENTITY_MISMATCH'
    );
  });

  await t.test('rejects SKU identity mismatch with IDENTITY_MISMATCH', () => {
    const withSku = { ...expected, sku: 'AUR-10120' };
    assert.throws(
      () => validateScrapedProduct({ ...withSku, sku: 'WRONG-SKU-999', price: 500, stock_status: 'in_stock' }, withSku),
      (err) => err.errorType === 'IDENTITY_MISMATCH'
    );
  });
});

test('ScrapeProduct Pipeline Orchestration (Mocked Scraper)', async (t) => {
  const product = { store_product_id: '459', name: 'Domus Sling Plus' };

  await t.test('succeeds on first attempt (success)', async () => {
    const mockScraper = async () => ({ html: normalHtml, httpStatus: 200 });
    const result = await scrapeProduct(product, { scraperFn: mockScraper, maxAttempts: 3 });

    assert.equal(result.success, true);
    assert.equal(result.attempts, 1);
    assert.equal(result.data.price, 6727);
    assert.equal(result.attempt_details.length, 1);
    assert.equal(result.attempt_details[0].outcome, 'success');
  });

  await t.test('retries on placeholder and succeeds on attempt 2 (retried)', async () => {
    let callCount = 0;
    const mockScraper = async () => {
      callCount++;
      if (callCount === 1) {
        return { html: placeholderHtml, httpStatus: 200 };
      }
      return { html: normalHtml, httpStatus: 200 };
    };

    const result = await scrapeProduct(product, {
      scraperFn: mockScraper,
      maxAttempts: 3,
      timeoutMs: 500
    });

    assert.equal(result.success, true);
    assert.equal(result.attempts, 2);
    assert.equal(result.attempt_details.length, 2);
    assert.equal(result.attempt_details[0].outcome, 'failed');
    assert.equal(result.attempt_details[0].error_type, 'PLACEHOLDER');
    assert.equal(result.attempt_details[1].outcome, 'success');
  });

  await t.test('HTTP 404 is NOT retried (immediate failure)', async () => {
    let callCount = 0;
    const mockScraper = async () => {
      callCount++;
      return { html: errorPageHtml, httpStatus: 404 };
    };

    const result = await scrapeProduct(product, {
      scraperFn: mockScraper,
      maxAttempts: 3
    });

    assert.equal(result.success, false);
    assert.equal(result.attempts, 1, 'Should stop after 1 attempt on 404');
    assert.equal(result.error_type, 'HTTP_4XX');
    assert.equal(callCount, 1);
  });

  await t.test('all attempts fail exhausted', async () => {
    const mockScraper = async () => {
      throw new Error('net::ERR_CONNECTION_REFUSED');
    };

    const result = await scrapeProduct(product, {
      scraperFn: mockScraper,
      maxAttempts: 2,
      timeoutMs: 300
    });

    assert.equal(result.success, false);
    assert.equal(result.attempts, 2);
    assert.equal(result.error_type, 'NETWORK');
    assert.equal(result.attempt_details.length, 2);
  });

  await t.test('missing element classified as PARSE_ERROR', async () => {
    const mockScraper = async () => ({ html: structureShiftHtml, httpStatus: 200 });
    const result = await scrapeProduct(product, {
      scraperFn: mockScraper,
      maxAttempts: 1
    });

    assert.equal(result.success, false);
    assert.equal(result.error_type, 'PARSE_ERROR');
  });

  await t.test('identity mismatch classified as IDENTITY_MISMATCH', async () => {
    const wrongProduct = { store_product_id: '999', name: 'Non-Existent Product' };
    const mockScraper = async () => ({ html: normalHtml, httpStatus: 200 });
    const result = await scrapeProduct(wrongProduct, {
      scraperFn: mockScraper,
      maxAttempts: 1
    });

    assert.equal(result.success, false);
    assert.equal(result.error_type, 'IDENTITY_MISMATCH');
  });
});

test('SearchProducts Logic', async (t) => {
  await t.test('returns empty list on query shorter than 2 chars', async () => {
    assert.deepEqual(await searchProducts(''), []);
    assert.deepEqual(await searchProducts('a'), []);
  });

  await t.test('filters products by partial match', async () => {
    // searchProducts will query /api/catalog and cache
    const results = await searchProducts('sling');
    assert.ok(Array.isArray(results));
    if (results.length > 0) {
      assert.ok(results.some((r) => r.name.toLowerCase().includes('sling')));
      const first = results[0];
      assert.ok(first.store_product_id);
      assert.ok(first.name);
      assert.ok(first.url);
    }
  });
});
