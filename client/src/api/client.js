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

/**
 * Robust fetch wrapper handling Render sleeping cold starts, automatic retries, and friendly wake notices.
 */
async function request(endpoint, options = {}, retries = 2) {
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

    // If network error / cold start sleep timeout, retry with friendly wake state
    if (retries > 0 && (err.name === 'TypeError' || err.message.includes('fetch') || err.message.includes('NetworkError'))) {
      setServerWaking(true);
      await new Promise(r => setTimeout(r, 2000));
      return request(endpoint, options, retries - 1);
    }

    if (err.name === 'TypeError' && err.message.includes('fetch')) {
      setServerWaking(true);
      const friendlyErr = new Error('Waking up the server (Render free instance sleeps when idle and may take up to 60s). Retrying...');
      throw friendlyErr;
    }

    setServerWaking(false);
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
