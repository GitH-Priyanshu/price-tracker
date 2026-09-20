import React from 'react';
import StatusPill from './StatusPill.jsx';

/**
 * Plain table displaying recorded price history points under the chart.
 * Columns: Timestamp, Price, Stock Status, Quantity
 */
export default function PriceHistoryTable({ history = [] }) {
  if (!history || history.length === 0) {
    return (
      <p style={{ color: 'var(--text-muted)', fontSize: 'var(--font-sm)', margin: 'var(--space-2) 0 var(--space-4)' }}>
        No historical price records logged for this product yet.
      </p>
    );
  }

  // Sort descending by timestamp so newest records appear first
  const sorted = [...history].sort(
    (a, b) => new Date(b.scraped_at || b.recorded_at || b.created_at) - new Date(a.scraped_at || a.recorded_at || a.created_at)
  );

  return (
    <div style={{ marginBottom: 'var(--space-4)' }}>
      <table>
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>Price</th>
            <th>Stock Status</th>
            <th>Available Qty</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((item, idx) => {
            const ts = item.scraped_at || item.recorded_at || item.created_at;
            const timeStr = ts ? new Date(ts).toLocaleString() : '—';
            const priceStr = item.price != null ? `₹${Number(item.price).toLocaleString('en-IN')}` : '—';
            const stock = item.stock_status || 'unknown';
            const qtyStr = item.stock_quantity != null ? item.stock_quantity : '—';

            return (
              <tr key={item.id || idx}>
                <td style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)' }}>{timeStr}</td>
                <td style={{ fontWeight: 600 }}>{priceStr}</td>
                <td><StatusPill status={stock} /></td>
                <td className="mono">{qtyStr}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
