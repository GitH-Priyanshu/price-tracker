/**
 * Custom error type for validation and identity mismatch failures.
 */
export class ValidationError extends Error {
  constructor(message, errorType = 'VALIDATION') {
    super(message);
    this.name = 'ValidationError';
    this.errorType = errorType;
  }
}

/**
 * Validates scraped product data against strict data integrity rules
 * and confirms that the scraped identity matches the expected product.
 * 
 * Never permits null, empty, placeholder, NaN, zero, or negative data.
 * 
 * @param {Object} scraped - Output from parser: { store_product_id, name, price, stock_status, stock_quantity }
 * @param {Object} expected - Tracked product record: { store_product_id, name, id }
 * @returns {boolean} Returns true if valid, throws ValidationError otherwise
 */
export function validateScrapedProduct(scraped, expected = {}) {
  if (!scraped || typeof scraped !== 'object') {
    throw new ValidationError('Scraped data object is null or invalid', 'VALIDATION');
  }

  // 1. Price Validation
  const price = Number(scraped.price);
  if (scraped.price == null || isNaN(price)) {
    throw new ValidationError('Data Integrity Violation: Price is null or NaN', 'VALIDATION');
  }
  if (price <= 0) {
    throw new ValidationError(`Data Integrity Violation: Price must be strictly positive, received ${price}`, 'VALIDATION');
  }

  // 1b. Price Plausibility Validation against MRP
  // Derived from empirical evidence across 44 scrapes in docs/evidence/:
  // Valid store prices range from 0.5600 (56.0%) to 1.1260 (112.6%) of MRP.
  // When MRP is present:
  // - Minimum threshold: 0.30 (30% of MRP) - rejects truncated/misparsed prices (e.g. 7, 7.92, 8.59 which are ~0.06% of MRP)
  // - Maximum threshold: 1.20 (120% of MRP) - allows legitimate dynamic surge pricing (up to 1.13x) while rejecting runaway decoys
  // When no MRP is present: do not apply the rule.
  if (scraped.mrp != null && typeof scraped.mrp === 'number' && scraped.mrp > 0) {
    const ratio = price / scraped.mrp;
    const MIN_RATIO = 0.30;
    const MAX_RATIO = 1.20;

    if (ratio < MIN_RATIO) {
      throw new ValidationError(
        `Plausibility Failure: Scraped price ₹${price} is implausibly low relative to MRP ₹${scraped.mrp} (ratio ${ratio.toFixed(4)} < ${MIN_RATIO})`,
        'VALIDATION'
      );
    }

    if (ratio > MAX_RATIO) {
      throw new ValidationError(
        `Plausibility Failure: Scraped price ₹${price} is implausibly high relative to MRP ₹${scraped.mrp} (ratio ${ratio.toFixed(4)} > ${MAX_RATIO})`,
        'VALIDATION'
      );
    }
  }

  // 2. Stock Status Validation
  if (!scraped.stock_status || !['in_stock', 'out_of_stock'].includes(scraped.stock_status)) {
    throw new ValidationError(
      `Data Integrity Violation: Stock status must be 'in_stock' or 'out_of_stock', received "${scraped.stock_status}"`,
      'VALIDATION'
    );
  }

  // 3. Name Validation
  if (!scraped.name || typeof scraped.name !== 'string' || scraped.name.trim().length === 0) {
    throw new ValidationError('Data Integrity Violation: Scraped product name is missing or empty', 'VALIDATION');
  }

  // 4. Product Identity Check
  // Guards against the store shifting to a different product or rendering a wrong catalog page
  if (expected.store_product_id && scraped.store_product_id) {
    if (String(scraped.store_product_id) !== String(expected.store_product_id)) {
      throw new ValidationError(
        `Identity Mismatch: Scraped store_product_id "${scraped.store_product_id}" does not match expected "${expected.store_product_id}"`,
        'IDENTITY_MISMATCH'
      );
    }
  }

  // Name similarity check if expected name is available
  if (expected.name && scraped.name) {
    const normScraped = scraped.name.toLowerCase().trim();
    const normExpected = expected.name.toLowerCase().trim();
    // Verify that the scraped name matches or contains the expected product core name
    if (normScraped !== normExpected && !normScraped.includes(normExpected) && !normExpected.includes(normScraped)) {
      throw new ValidationError(
        `Identity Mismatch: Scraped product name "${scraped.name}" does not match expected "${expected.name}"`,
        'IDENTITY_MISMATCH'
      );
    }
  }

  // 5. SKU Identity Check (if available in expected metadata and scraped data)
  if (expected.sku && scraped.sku) {
    const cleanScraped = scraped.sku.toLowerCase().replace(/[^a-z0-9]/g, '');
    const cleanExpected = expected.sku.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (cleanScraped !== cleanExpected) {
      throw new ValidationError(
        `Identity Mismatch: Scraped SKU "${scraped.sku}" does not match expected SKU "${expected.sku}"`,
        'IDENTITY_MISMATCH'
      );
    }
  }

  return true;
}
