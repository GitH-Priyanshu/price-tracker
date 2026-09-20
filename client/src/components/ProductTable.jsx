import React from 'react';
import { Link } from 'react-router-dom';
import StatusPill from './StatusPill.jsx';

/**
 * Plain table listing active tracked products.
 */
export default function ProductTable({ products, onDeactivate, isDeactivating }) {
  if (!products || products.length === 0) {
    return (
      <p style={{ color: 'var(--text-muted)', margin: 'var(--space-4) 0' }}>
        No products are currently being tracked. Search the catalog or track a product below to get started.
      </p>
    );
  }

  return (
    <table>
      <thead>
        <tr>
          <th>Product</th>
          <th>SKU</th>
          <th>Current Price</th>
          <th>Stock</th>
          <th>Last Status</th>
          <th>Last Scraped</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {products.map((p) => {
          const price = p.latest_price?.price != null ? `₹${p.latest_price.price.toLocaleString('en-IN')}` : '—';
          const stock = p.latest_price?.stock_status || 'unknown';
          const lastScraped = p.last_scraped_at
            ? new Date(p.last_scraped_at).toLocaleString()
            : (p.latest_price?.scraped_at ? new Date(p.latest_price.scraped_at).toLocaleString() : (p.latest_price?.recorded_at ? new Date(p.latest_price.recorded_at).toLocaleString() : 'Pending'));

          return (
            <tr key={p.id}>
              <td>
                <Link to={`/products/${p.id}`} style={{ fontWeight: 500, color: 'var(--accent)' }}>
                  {p.name}
                </Link>
                <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)' }}>
                  ID: {p.store_product_id}
                </div>
              </td>
              <td className="mono">{p.sku || '—'}</td>
              <td style={{ fontWeight: 600 }}>{price}</td>
              <td><StatusPill status={stock} /></td>
              <td><StatusPill status={p.last_scrape_status || 'success'} /></td>
              <td style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)' }}>
                {lastScraped}
              </td>
              <td>
                <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                  <Link to={`/products/${p.id}`} className="btn btn-sm">
                    View
                  </Link>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={() => onDeactivate(p.id)}
                    disabled={isDeactivating === p.id}
                  >
                    {isDeactivating === p.id ? 'Removing...' : 'Untrack'}
                  </button>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
