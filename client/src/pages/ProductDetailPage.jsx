import React, { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import StatusPill from '../components/StatusPill.jsx';
import PriceChart from '../components/PriceChart.jsx';
import PriceHistoryTable from '../components/PriceHistoryTable.jsx';
import LogsTable from '../components/LogsTable.jsx';
import {
  getProduct,
  getProducts,
  getProductHistory,
  getProductLogs,
  refreshProduct,
  deactivateProduct
} from '../api/client.js';

export default function ProductDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [product, setProduct] = useState(null);
  const [history, setHistory] = useState([]);
  const [activeRange, setActiveRange] = useState('30d');
  const [logsData, setLogsData] = useState({ logs: [], total: 0 });
  const [logsOffset, setLogsOffset] = useState(0);

  const [isLoading, setIsLoading] = useState(true);
  const [isScraping, setIsScraping] = useState(false);
  const [isDeactivating, setIsDeactivating] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [error, setError] = useState(null);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);

  // Ticking cooldown timer
  useEffect(() => {
    if (cooldownSeconds <= 0) return;
    const interval = setInterval(() => {
      setCooldownSeconds((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [cooldownSeconds]);

  // When product loads, calculate remaining cooldown if scraped < 5 minutes ago
  useEffect(() => {
    if (product?.last_scraped_at) {
      const elapsed = (Date.now() - new Date(product.last_scraped_at).getTime()) / 1000;
      if (elapsed < 300) {
        setCooldownSeconds(Math.ceil(300 - elapsed));
      }
    }
  }, [product?.last_scraped_at]);

  const loadData = async (range = activeRange, offset = logsOffset) => {
    setError(null);
    try {
      let resolvedId = id;
      let prod;
      try {
        prod = await getProduct(resolvedId);
      } catch (err) {
        if (err.status === 404) {
          const all = await getProducts();
          const match = all.find((p) => String(p.store_product_id) === String(id));
          if (match) {
            resolvedId = match.id;
            prod = await getProduct(resolvedId);
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }

      const [hist, logs] = await Promise.all([
        getProductHistory(resolvedId, range),
        getProductLogs(resolvedId, 20, offset)
      ]);
      setProduct(prod);
      setHistory(hist);
      setLogsData(logs);
    } catch (err) {
      setError(err.message || 'Failed to load product details');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadData(activeRange, logsOffset);
  }, [id, activeRange, logsOffset]);

  const handleRangeChange = (newRange) => {
    setActiveRange(newRange);
  };

  const handlePageChange = (newOffset) => {
    setLogsOffset(newOffset);
  };

  const handleRefresh = async () => {
    if (cooldownSeconds > 0) return;
    setIsScraping(true);
    setFeedback(null);
    setError(null);
    try {
      const targetId = product?.id || id;
      await refreshProduct(targetId);
      setFeedback('Price refresh enqueued successfully. Updating latest data...');
      setCooldownSeconds(300);
      await loadData(activeRange, logsOffset);
    } catch (err) {
      if (err.status === 429) {
        const remaining = err.data?.error?.retry_after_seconds || err.data?.retry_after_seconds || 300;
        setCooldownSeconds(remaining);
        setError(err.message || `Cooldown active: please wait ${remaining}s before refreshing again.`);
      } else {
        setError(err.message || 'Refresh request failed');
      }
    } finally {
      setIsScraping(false);
    }
  };

  const handleDeactivate = async () => {
    if (!window.confirm(`Stop tracking "${product?.name}"?`)) {
      return;
    }
    setIsDeactivating(true);
    setError(null);
    try {
      await deactivateProduct(id);
      navigate('/');
    } catch (err) {
      setError(err.message || 'Failed to deactivate product');
      setIsDeactivating(false);
    }
  };

  if (isLoading) {
    return <main><p style={{ color: 'var(--text-muted)' }}>Loading product details...</p></main>;
  }

  if (error && !product) {
    return (
      <main>
        <Link to="/" className="btn btn-sm" style={{ marginBottom: 'var(--space-3)' }}>
          &larr; Back to Products
        </Link>
        <div className="alert alert-error">{error}</div>
      </main>
    );
  }

  const latestPrice = product?.latest_price?.price != null
    ? `₹${product.latest_price.price.toLocaleString('en-IN')}`
    : '—';
  const stockStatus = product?.latest_price?.stock_status || 'unknown';
  const stockQty = product?.latest_price?.stock_quantity != null
    ? product.latest_price.stock_quantity
    : 'N/A';
  const lastScraped = product?.last_scraped_at
    ? new Date(product.last_scraped_at).toLocaleString()
    : (product?.latest_price?.scraped_at
      ? new Date(product.latest_price.scraped_at).toLocaleString()
      : (product?.latest_price?.recorded_at ? new Date(product.latest_price.recorded_at).toLocaleString() : 'Never'));

  return (
    <main>
      <div style={{ marginBottom: 'var(--space-3)' }}>
        <Link to="/" className="btn btn-sm">
          &larr; Back to Products
        </Link>
      </div>

      {feedback && <div className="alert alert-success">{feedback}</div>}
      {error && <div className="alert alert-error">{error}</div>}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 'var(--space-3)', marginBottom: 'var(--space-4)' }}>
        <div>
          <h1>{product?.name}</h1>
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--font-sm)' }}>
            Store ID: <span className="mono">{product?.store_product_id}</span>
            {product?.sku && <> &bull; SKU: <span className="mono">{product.sku}</span></>}
            {product?.brand && <> &bull; Brand: {product.brand}</>}
            {product?.category && <> &bull; Category: {product.category}</>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 'var(--space-1)' }}>
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleRefresh}
                disabled={isScraping || cooldownSeconds > 0}
                title={cooldownSeconds > 0 ? `Cooldown active (${cooldownSeconds}s remaining)` : 'Refresh product price'}
              >
                {isScraping
                  ? 'Refreshing...'
                  : cooldownSeconds > 0
                  ? `Cooldown (${cooldownSeconds}s)`
                  : 'Refresh Price'}
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={handleDeactivate}
                disabled={isDeactivating}
              >
                {isDeactivating ? 'Untracking...' : 'Untrack'}
              </button>
            </div>
            {cooldownSeconds > 0 && (
              <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)' }}>
                Cooldown: {Math.floor(cooldownSeconds / 60)}m {cooldownSeconds % 60}s remaining
              </span>
            )}
          </div>
        </div>
      </div>

      <ul className="detail-list">
        <li className="detail-item">
          <span className="detail-label">Current Selling Price</span>
          <span className="detail-value" style={{ fontWeight: 600, fontSize: 'var(--font-lg)' }}>{latestPrice}</span>
        </li>
        <li className="detail-item">
          <span className="detail-label">Stock Status</span>
          <span className="detail-value"><StatusPill status={stockStatus} /></span>
        </li>
        <li className="detail-item">
          <span className="detail-label">Available Inventory Quantity</span>
          <span className="detail-value mono">{stockQty}</span>
        </li>
        <li className="detail-item">
          <span className="detail-label">Last Scrape Outcome</span>
          <span className="detail-value"><StatusPill status={product?.last_scrape_status || 'success'} /></span>
        </li>
        <li className="detail-item">
          <span className="detail-label">Last Scraped Timestamp</span>
          <span className="detail-value">{lastScraped}</span>
        </li>
        {product?.url && (
          <li className="detail-item">
            <span className="detail-label">Store Page URL</span>
            <span className="detail-value">
              <a href={product.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>
                Open Store Listing &rarr;
              </a>
            </span>
          </li>
        )}
      </ul>

      {/* Level F2: Price History Chart */}
      <h2>Price History</h2>
      <PriceChart
        history={history}
        activeRange={activeRange}
        onRangeChange={handleRangeChange}
      />

      <PriceHistoryTable history={history} />

      {/* Level F3: Scrape Audit Logs */}
      <h2>Scrape Execution Logs</h2>
      <p style={{ color: 'var(--text-muted)', fontSize: 'var(--font-sm)', marginBottom: 'var(--space-2)' }}>
        Execution telemetry recorded for each scrape attempt:
      </p>
      <LogsTable
        logs={logsData.logs}
        total={logsData.total}
        limit={20}
        offset={logsOffset}
        onPageChange={handlePageChange}
      />
    </main>
  );
}
