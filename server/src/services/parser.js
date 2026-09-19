/**
 * Custom error type for parsing failures.
 */
export class ParseError extends Error {
  constructor(message, errorType = 'PARSE_ERROR') {
    super(message);
    this.name = 'ParseError';
    this.errorType = errorType;
  }
}

/**
 * Normalizes full-width unicode numerals (0xFF10 - 0xFF19) to standard ASCII '0'-'9'.
 * @param {string} str
 * @returns {string}
 */
export function normalizeUnicodeDigits(str) {
  return str.replace(/[\uFF10-\uFF19]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0));
}

/**
 * Sanitizes and extracts a numeric price value from messy, obfuscated text.
 * Handles:
 * - Currency symbols (₹, Rs., INR)
 * - Zero-width spaces (\u200B, \u200C, \u200D, \uFEFF)
 * - Non-breaking spaces (\xA0, \u202F)
 * - Indian number formatting (e.g. 1,00,000 or 6,727)
 * - Euro format (e.g. 6.727,00)
 * - Spaced format (e.g. 6 727)
 * - Trailing suffixes (e.g. /- (incl. of all taxes))
 * 
 * @param {string} rawText
 * @returns {number} Clean positive float
 */
export function parsePriceText(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    throw new ParseError('Price text is missing or empty', 'PARSE_ERROR');
  }

  // Check for placeholder or loading messages
  const lower = rawText.toLowerCase();
  const placeholders = [
    'price hidden',
    'loading',
    'loading current price',
    'updating',
    'retrying',
    'hover over the price area',
    'hold on — checking availability',
    'check the current price'
  ];

  for (const ph of placeholders) {
    if (lower.includes(ph)) {
      throw new ParseError(`Detected loading/placeholder state: "${ph}"`, 'PLACEHOLDER');
    }
  }

  // 1. Normalize unicode digits to 0-9
  let cleaned = normalizeUnicodeDigits(rawText);

  // 2. Strip zero-width characters and invisible noise
  cleaned = cleaned.replace(/[\u200B-\u200D\uFEFF]/g, '');

  // 3. Strip non-breaking spaces and whitespace tabs
  cleaned = cleaned.replace(/[\xA0\u202F\s]+/g, ' ').trim();

  // 4. Strip currency words and symbols
  cleaned = cleaned.replace(/(?:₹|rs\.?|inr|\/-|\(incl\. of all taxes\))/gi, '').trim();

  // 5. Detect and normalize thousand and decimal separators
  // Case A: Both . and , are present
  if (cleaned.includes('.') && cleaned.includes(',')) {
    if (cleaned.indexOf('.') < cleaned.indexOf(',')) {
      // Euro format: "6.727,00" or "61.925,00" -> '.' is thousands, ',' is decimal
      cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      // Standard format: "6,727.00" -> ',' is thousands, '.' is decimal
      cleaned = cleaned.replace(/,/g, '');
    }
  } else if (cleaned.includes(',')) {
    // Only comma present:
    // e.g. "6727,00" (euro decimal) vs "6,727" (standard thousands)
    if (/,\d{2}$/.test(cleaned)) {
      cleaned = cleaned.replace(',', '.');
    } else {
      cleaned = cleaned.replace(/,/g, '');
    }
  } else if (cleaned.includes('.')) {
    // Only period present:
    // If there is a single period followed by 3 digits (e.g. "61.925" or "7.493"),
    // it is ambiguous whether it represents a European thousands separator or a 3-digit decimal.
    // Strict data integrity rule: DO NOT GUESS. Reject with PARSE_ERROR so the scrape is retried.
    if (/^\d+\.\d{3}$/.test(cleaned)) {
      throw new ParseError(
        `Ambiguous price format "${rawText}": cannot distinguish between thousands and decimal separator without guessing`,
        'PARSE_ERROR'
      );
    }
  }

  // Strip remaining spaces
  cleaned = cleaned.replace(/\s+/g, '');

  // Match any remaining digits and optional decimal
  const match = cleaned.match(/(\d+(?:\.\d+)?)/);
  if (!match) {
    throw new ParseError(`Failed to extract numeric price from: "${rawText}"`, 'PARSE_ERROR');
  }

  const num = parseFloat(match[1]);
  if (isNaN(num) || num <= 0) {
    throw new ParseError(`Parsed invalid non-positive price: ${num} from "${rawText}"`, 'PARSE_ERROR');
  }

  return Math.round(num * 100) / 100;
}

/**
 * Parses raw stock badge text and extracts normalized status and quantity.
 * @param {string} rawText
 * @param {string} [className]
 * @returns {{ stock_status: 'in_stock'|'out_of_stock', stock_quantity: number|null }}
 */
export function parseStockText(rawText = '', className = '') {
  const combined = `${className} ${rawText}`.toLowerCase();

  // Check out of stock
  if (combined.includes('out-stock') || combined.includes('out of stock')) {
    return {
      stock_status: 'out_of_stock',
      stock_quantity: 0
    };
  }

  // Check in stock variations: "In stock · 100 left", "Only 5 left", "10 in stock", "Selling fast — 8 left"
  if (combined.includes('in-stock') || combined.includes('in stock') || combined.includes('left')) {
    const qtyMatch = rawText.match(/(\d+)\s*(?:left|in stock)/i) || rawText.match(/(?:only|just)\s*(\d+)/i) || rawText.match(/(\d+)/);
    const qty = qtyMatch ? parseInt(qtyMatch[1], 10) : null;
    return {
      stock_status: 'in_stock',
      stock_quantity: qty
    };
  }

  throw new ParseError(`Unable to determine stock status from: "${rawText}"`, 'PARSE_ERROR');
}

/**
 * Parses rendered HTML content of a product detail page.
 * Pure function: string HTML in, extracted fields out.
 * 
 * @param {string} html
 * @param {Object} [fallbackMeta] - Static product metadata if available
 * @returns {{ store_product_id: string, name: string, price: number, stock_status: string, stock_quantity: number|null }}
 */
export function parseProductHtml(html, fallbackMeta = {}) {
  if (!html || typeof html !== 'string') {
    throw new ParseError('Missing HTML input to parseProductHtml', 'PARSE_ERROR');
  }

  // 1. Check for 404 / error page
  if (
    html.includes('product 404') ||
    html.includes('grid-error') ||
    html.includes('Couldn’t load this product') ||
    html.includes('Product not found') ||
    html.includes('Page Not Found') ||
    html.includes('404')
  ) {
    throw new ParseError('Product page returned 404 / not found', 'HTTP_4XX');
  }

  // 2. Check for unrevealed placeholder state
  if (html.includes('price-idle') || html.includes('Price hidden') || html.includes('Hover over the price area')) {
    throw new ParseError('Product price is in unrevealed placeholder state', 'PLACEHOLDER');
  }

  // 3. Extract product name (from h1 or fallbackMeta)
  const nameMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  const name = nameMatch ? nameMatch[1].trim() : (fallbackMeta.name || '').trim();
  if (!name) {
    throw new ParseError('Expected <h1> element containing product name is missing', 'PARSE_ERROR');
  }

  // 4. Verify presence of price container
  if (!html.includes('price-main') && !html.includes('price-block')) {
    throw new ParseError('Expected .price-block or .price-main container is missing', 'PARSE_ERROR');
  }

  // 5. Extract the VISIBLE price element
  // The mock store renders real price in <output ...> or visible <span class="pv-*">
  // while injecting decoy elements (display: none), MRP (mr-*), Deal price (sl-*), and badge (bd-*)
  let priceText = null;

  // Strategy 1: Targeted container extraction by stripping non-active elements from .price-main
  const priceMainMatch = html.match(/<div class="price-main"[^>]*>([\s\S]*?)<\/div>/i);
  if (priceMainMatch) {
    let inner = priceMainMatch[1];
    // Strip display: none elements (decoys like .price-value and .amount)
    inner = inner.replace(/<[^>]+style="[^"]*display:\s*none[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gi, '');
    // Strip MRP (strikethrough) elements (.mr-*)
    inner = inner.replace(/<[^>]+class="[^"]*\bmr-[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gi, '');
    // Strip Deal price elements (.sl-*)
    inner = inner.replace(/<[^>]+class="[^"]*\bsl-[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gi, '');
    // Strip discount badge elements (.bd-*)
    inner = inner.replace(/<[^>]+class="[^"]*\bbd-[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gi, '');
    // Strip transient status text like Updating…
    inner = inner.replace(/<span[^>]*>[^<]*updating[^<]*<\/span>/gi, '');

    const textOnly = inner.replace(/<[^>]+>/g, ' ').trim();
    if (textOnly && (textOnly.includes('₹') || textOnly.includes('Rs') || /\d/.test(textOnly))) {
      priceText = textOnly;
    }
  }

  // Strategy 2: Look for <output ...>...</output> tag
  if (!priceText) {
    const outputMatch = html.match(/<output[^>]*>([\s\S]*?)<\/output>/i);
    if (outputMatch) {
      priceText = outputMatch[1].replace(/<[^>]+>/g, '').trim();
    }
  }

  // Strategy 3: Look for unhidden pv-* class tag
  if (!priceText) {
    const pvMatch = html.match(/<(?:output|span|div)[^>]*class="[^"]*\bpv-[^"]*"[^>]*>([\s\S]*?)<\/(?:output|span|div)>/i);
    if (pvMatch && !pvMatch[0].includes('display: none') && !pvMatch[0].includes('aria-hidden="true"')) {
      priceText = pvMatch[1].replace(/<[^>]+>/g, '').trim();
    }
  }

  if (!priceText) {
    throw new ParseError('No visible, non-decoy price element found in DOM', 'PARSE_ERROR');
  }

  const price = parsePriceText(priceText);

  // 6. Extract stock status from stock badge
  let stockBadgeMatch = html.match(/<span[^>]*class="[^"]*stock-badge[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
  let stockClass = '';
  let stockRawText = '';

  if (stockBadgeMatch) {
    stockClass = stockBadgeMatch[0];
    stockRawText = stockBadgeMatch[1].replace(/<[^>]+>/g, '').trim();
  } else {
    // check st-* class
    const stMatch = html.match(/<div[^>]*class="[^"]*st-[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (stMatch) {
      stockClass = stMatch[0];
      stockRawText = stMatch[1].replace(/<[^>]+>/g, '').trim();
    }
  }

  if (!stockRawText) {
    throw new ParseError('Expected .stock-badge element is missing', 'PARSE_ERROR');
  }

  const { stock_status, stock_quantity } = parseStockText(stockRawText, stockClass);

  // 7. Extract SKU / Product ID from page if present
  const skuMatch = html.match(/(?:sku|item|product code)[\s:#_-]*([a-z0-9-]+)/i) ||
                   html.match(/\b([A-Z]{3}-\d+)\b/) ||
                   html.match(/data-sku="([^"]+)"/i);
  const sku = skuMatch ? (skuMatch[1] || skuMatch[0]).trim() : null;

  // 8. Store product ID
  const storeProductId = String(fallbackMeta.store_product_id || fallbackMeta.id || '');

  return {
    store_product_id: storeProductId,
    name,
    sku,
    price,
    stock_status,
    stock_quantity
  };
}
