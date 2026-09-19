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

  return true;
}
