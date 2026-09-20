const envUrl = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');
const isDev = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

// In local dev, use relative path to leverage Vite proxy to avoid CORS header issues with Render
const API_BASE = isDev ? '' : (envUrl || 'https://price-tracker-h20m.onrender.com');

let wakeListeners = new Set();
let isServerWaking = false;

export function subscribeServerWake(listener) {
  wakeListeners.add(listener);
  listener(isServerWaking);
  return () => wakeListeners.delete(listener);
}

function setServerWaking(val) {
  if (isServerWaking !== val) {
    isServerWaking = val;
    wakeListeners.forEach(l => l(val));
  }
}

const MAX_RETRIES = 3;
const MAX_WAIT_BUDGET_MS = 90000; // 90 seconds max budget

/**
 * Robust fetch wrapper handling Render sleeping cold starts, automatic retries, and friendly wake notices.
 * Halts after 3 retries or 90s, stops waking state, and surfaces real network/CORS error.
 */
async function request(endpoint, options = {}, retries = MAX_RETRIES, startTime = Date.now()) {
  const url = `${API_BASE}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  // Timer: if request takes > 2.0s, signal that the Render instance is waking up
  const timer = setTimeout(() => {
    setServerWaking(true);
  }, 2000);

  try {
    const res = await fetch(url, {
      ...options,
      headers
    });

    clearTimeout(timer);
    setServerWaking(false);

    const contentType = res.headers.get('content-type') || '';
    const isJson = contentType.includes('application/json');
    const data = isJson ? await res.json() : await res.text();

    if (!res.ok) {
      const message = (data && data.error && data.error.message) ||
                      (data && data.message) ||
                      `Request failed with status ${res.status}`;
      const err = new Error(message);
      err.status = res.status;
      err.data = data;
      throw err;
    }

    return data;
  } catch (err) {
    clearTimeout(timer);

    const elapsed = Date.now() - startTime;
    const isNetworkError = err.name === 'TypeError' ||
                          (err.message && (err.message.includes('fetch') ||
                                           err.message.includes('NetworkError') ||
                                           err.message.includes('Failed to fetch')));

    // If network error, still have retries, and within 90s budget, retry
    if (retries > 0 && elapsed < MAX_WAIT_BUDGET_MS && isNetworkError) {
      setServerWaking(true);
      await new Promise(r => setTimeout(r, 2000));
      return request(endpoint, options, retries - 1, startTime);
    }

    // Retries exhausted or budget exceeded: clear waking state and throw real actionable error
    setServerWaking(false);

    if (isNetworkError) {
      const realError = new Error(`Cannot reach the backend: CORS or network error (${err.message || 'connection failed'})`);
      realError.originalError = err;
      throw realError;
    }

    throw err;
  }
}

// Health probe
export async function getHealth() {
  return request('/api/health');
}

// Level F1: Catalog search & Tracked products
export async function searchCatalog(query) {
  return request(`/api/search?q=${encodeURIComponent(query)}`);
}

export async function getProducts() {
  const data = await request('/api/products');
  return data.products || [];
}

export async function trackProduct(storeProductId, overrides = {}) {
  return request('/api/products', {
    method: 'POST',
    body: JSON.stringify({ store_product_id: String(storeProductId), ...overrides })
  });
}

export async function deactivateProduct(id) {
  return request(`/api/products/${id}`, {
    method: 'DELETE'
  });
}

// Level F2: Single product detail & Price history
export async function getProduct(id) {
  const data = await request(`/api/products/${id}`);
  return data.product || data;
}

export async function getProductHistory(id, range = '30d') {
  const query = range === 'all' ? '' : `?range=${range}`;
  const data = await request(`/api/products/${id}/history${query}`);
  return data.history || [];
}

// Public product price refresh (enforces 5-minute per-product cooldown, queue cap, rate limiter)
export async function refreshProduct(id) {
  return request(`/api/products/${id}/refresh?wait=true`, {
    method: 'POST'
  });
}

// Level F3: Scrape execution logs
export async function getProductLogs(id, limit = 20, offset = 0) {
  const data = await request(`/api/products/${id}/logs?limit=${limit}&offset=${offset}`);
  return {
    logs: data.logs || [],
    total: data.total || 0,
    count: data.count || 0
  };
}
