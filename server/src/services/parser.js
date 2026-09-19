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

  // 5. Detect and normalize Euro formatting: e.g. "6.727,00" -> "6727.00"
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d{2})?$/.test(cleaned)) {
    cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (/^\d+(?:,\d{2})$/.test(cleaned)) {
    // e.g. "6727,00"
    cleaned = cleaned.replace(',', '.');
  } else {
    // Standard format: commas or spaces are thousand separators: "6,727.00" or "6 727"
    cleaned = cleaned.replace(/[,\s]/g, '');
  }

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
  // while injecting decoy elements with style="display: none;"
  let priceText = null;

  // Pattern A: Look for <output ...>...</output> tag (from layout.priceTag)
  const outputMatch = html.match(/<output[^>]*>([\s\S]*?)<\/output>/i);
  if (outputMatch) {
    // Strip nested tags (<span>...</span>) to get inner text
    priceText = outputMatch[1].replace(/<[^>]+>/g, '').trim();
  }

  // Pattern B: Look for unhidden pv-* class tag
  if (!priceText) {
    const pvMatch = html.match(/<([a-z0-9]+)[^>]*class="[^"]*pv-[^"]*"[^>]*>([\s\S]*?)<\/\1>/i);
    if (pvMatch && !pvMatch[0].includes('display: none') && !pvMatch[0].includes('aria-hidden="true"')) {
      priceText = pvMatch[2].replace(/<[^>]+>/g, '').trim();
    }
  }

  // Pattern C: Find all elements inside .price-main that are NOT hidden
  if (!priceText) {
    const priceMainMatch = html.match(/<div class="price-main"[^>]*>([\s\S]*?)<\/div>/i);
    if (priceMainMatch) {
      const inner = priceMainMatch[1];
      // remove display: none elements
      const stripped = inner.replace(/<[^>]+style="[^"]*display:\s*none[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gi, '');
      // remove mr-* (mrp) elements
      const noMrp = stripped.replace(/<[^>]+class="[^"]*mr-[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gi, '');
      // remove bd-* (discount badge) elements
      const noBadge = noMrp.replace(/<[^>]+class="[^"]*bd-[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gi, '');
      
      const textOnly = noBadge.replace(/<[^>]+>/g, ' ').trim();
      if (textOnly) {
        priceText = textOnly;
      }
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

  // 7. Store product ID
  const storeProductId = String(fallbackMeta.store_product_id || fallbackMeta.id || '');

  return {
    store_product_id: storeProductId,
    name,
    price,
    stock_status,
    stock_quantity
  };
}
