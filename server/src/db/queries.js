import { getSupabaseClient } from './client.js';

/**
 * Creates a new product or reactivates an existing one by store_product_id.
 * Idempotent on store_product_id.
 * @param {Object} productData
 * @param {string} productData.store_product_id
 * @param {string} productData.name
 * @param {string} [productData.url]
 * @param {string} [productData.image_url]
 * @param {string} [productData.category]
 * @param {string} [productData.brand]
 * @param {string} [productData.sku]
 * @param {string} [productData.description]
 * @returns {Promise<Object>} Created or updated product record
 */
export async function createProduct(productData) {
  const supabase = getSupabaseClient();
  const { store_product_id, name, url, image_url, category, brand, sku, description } = productData;

  if (!store_product_id || !name) {
    throw new Error('store_product_id and name are required to create a product');
  }

  // Check if product already exists
  const existing = await getProductByStoreId(store_product_id);
  if (existing) {
    // If it was deactivated, reactivate it and update metadata
    const { data, error } = await supabase
      .from('products')
      .update({
        name,
        url: url || existing.url,
        image_url: image_url || existing.image_url,
        category: category || existing.category,
        brand: brand || existing.brand,
        sku: sku || existing.sku,
        description: description || existing.description,
        is_active: true
      })
      .eq('id', existing.id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  // Insert new product
  const { data, error } = await supabase
    .from('products')
    .insert({
      store_product_id: String(store_product_id),
      name,
      url,
      image_url,
      category,
      brand,
      sku,
      description,
      is_active: true
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Retrieves a product by its store_product_id.
 * @param {string|number} storeProductId
 * @returns {Promise<Object|null>}
 */
export async function getProductByStoreId(storeProductId) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .eq('store_product_id', String(storeProductId))
    .maybeSingle();

  if (error) throw error;
  return data;
}

/**
 * Lists all active tracked products.
 * @returns {Promise<Array<Object>>}
 */
export async function listActiveProducts() {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .eq('is_active', true)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

/**
 * Retrieves a product by internal UUID id.
 * @param {string} productId
 * @returns {Promise<Object|null>}
 */
export async function getProduct(productId) {
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!productId || typeof productId !== 'string' || !UUID_REGEX.test(productId)) {
    return null;
  }
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .eq('id', productId)
    .maybeSingle();

  if (error) {
    if (error.code === '22P02') return null;
    throw error;
  }
  return data;
}

/**
 * Deactivates a product (stops tracking).
 * @param {string} productId
 * @returns {Promise<Object|null>}
 */
export async function deactivateProduct(productId) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('products')
    .update({ is_active: false })
    .eq('id', productId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Inserts a validated successful scrape into price_history.
 * NEVER call with unvalidated, placeholder, or failed scrape data.
 * @param {Object} data
 * @param {string} data.product_id
 * @param {number} data.price
 * @param {string} data.stock_status - 'in_stock' | 'out_of_stock'
 * @param {number} [data.stock_quantity]
 * @param {Date|string} [data.scraped_at]
 * @returns {Promise<Object>} The inserted row including id
 */
export async function insertPriceHistory(data) {
  const supabase = getSupabaseClient();
  const { product_id, price, stock_status, stock_quantity, scraped_at } = data;

  const numPrice = Number(price);
  if (isNaN(numPrice) || numPrice <= 0) {
    throw new Error(`Data Integrity Violation: Refusing to insert invalid price ${price}`);
  }

  if (!['in_stock', 'out_of_stock'].includes(stock_status)) {
    throw new Error(`Data Integrity Violation: Unknown stock status ${stock_status}`);
  }

  const { data: inserted, error } = await supabase
    .from('price_history')
    .insert({
      product_id,
      price: numPrice,
      stock_status,
      stock_quantity: stock_quantity != null ? parseInt(stock_quantity, 10) : null,
      scraped_at: scraped_at || new Date().toISOString()
    })
    .select()
    .single();

  if (error) throw error;
  return inserted;
}

/**
 * Retrieves chronological price history for a product.
 * @param {string} productId
 * @param {string|Object} [range] - '24h', '7d', '30d', or { from, to }
 * @returns {Promise<Array<Object>>}
 */
export async function getPriceHistory(productId, range) {
  const supabase = getSupabaseClient();
  let query = supabase
    .from('price_history')
    .select('*')
    .eq('product_id', productId)
    .order('scraped_at', { ascending: true });

  if (range) {
    let fromDate = null;
    const now = new Date();

    if (typeof range === 'string') {
      if (range === '24h') fromDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      else if (range === '7d') fromDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      else if (range === '30d') fromDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    } else if (range.from) {
      fromDate = new Date(range.from);
    }

    if (fromDate) {
      query = query.gte('scraped_at', fromDate.toISOString());
    }
    if (range && range.to) {
      query = query.lte('scraped_at', new Date(range.to).toISOString());
    }
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

/**
 * Retrieves the single latest validated price for a product.
 * @param {string} productId
 * @returns {Promise<Object|null>}
 */
export async function getLatestPrice(productId) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('price_history')
    .select('*')
    .eq('product_id', productId)
    .order('scraped_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/**
 * Inserts a scrape attempt log record into scrape_logs.
 * Records every run honestly (success, retried, or failed).
 * @param {Object} logData
 * @returns {Promise<Object>}
 */
export async function insertScrapeLog(logData) {
  const supabase = getSupabaseClient();
  const {
    product_id,
    run_id,
    started_at,
    finished_at,
    status,
    attempts,
    http_status,
    error_type,
    error_message,
    duration_ms,
    attempt_details,
    price_history_id
  } = logData;

  if (!['success', 'retried', 'failed'].includes(status)) {
    throw new Error(`Invalid scrape log status: ${status}`);
  }

  const { data, error } = await supabase
    .from('scrape_logs')
    .insert({
      product_id,
      run_id,
      started_at,
      finished_at,
      status,
      attempts: attempts || 1,
      http_status: http_status || null,
      error_type: error_type || null,
      error_message: error_message || null,
      duration_ms: duration_ms != null ? duration_ms : 0,
      attempt_details: attempt_details || [],
      price_history_id: price_history_id || null
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Retrieves paginated scrape logs for a product, newest first.
 * @param {string} productId
 * @param {number} [limit=50]
 * @param {number} [offset=0]
 * @returns {Promise<{ logs: Array<Object>, total: number }>}
 */
export async function getScrapeLogs(productId, limit = 50, offset = 0) {
  const supabase = getSupabaseClient();
  const { data, error, count } = await supabase
    .from('scrape_logs')
    .select('*', { count: 'exact' })
    .eq('product_id', productId)
    .order('started_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return { logs: data || [], total: count || 0 };
}

/**
 * Updates a product's last scrape timestamp and status.
 * @param {string} productId
 * @param {'success'|'retried'|'failed'} status
 * @param {Date|string} [lastScrapedAt]
 * @returns {Promise<Object>}
 */
export async function updateProductScrapeStatus(productId, status, lastScrapedAt = new Date().toISOString()) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('products')
    .update({
      last_status: status,
      last_scraped_at: lastScrapedAt
    })
    .eq('id', productId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Retrieves the started_at timestamp of the most recent scrape log for a product.
 * Used by the duplicate-trigger guard in Level B4.
 * @param {string} productId
 * @returns {Promise<Date|null>}
 */
export async function getMostRecentLogStart(productId) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('scrape_logs')
    .select('started_at')
    .eq('product_id', productId)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data?.started_at ? new Date(data.started_at) : null;
}
