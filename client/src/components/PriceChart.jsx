import React from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid
} from 'recharts';

/**
 * Recharts single line chart for product price history.
 * Minimalist, default styling using the single accent color (#0969da).
 */
export default function PriceChart({ history = [], activeRange = '30d', onRangeChange }) {
  const ranges = [
    { label: '24h', value: '24h' },
    { label: '7d', value: '7d' },
    { label: '30d', value: '30d' },
    { label: 'All', value: 'all' }
  ];

  const formattedData = [...history]
    .sort((a, b) => new Date(a.scraped_at || a.recorded_at || a.created_at) - new Date(b.scraped_at || b.recorded_at || b.created_at))
    .map((item) => {
      const ts = item.scraped_at || item.recorded_at || item.created_at;
      const d = new Date(ts);
      return {
        timestamp: ts,
        dateLabel: activeRange === '24h'
          ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : d.toLocaleDateString([], { month: 'short', day: 'numeric' }),
        price: item.price,
        stockStatus: item.stock_status
      };
    });

  const customTooltip = ({ active, payload }) => {
    if (active && payload && payload.length) {
      const point = payload[0].payload;
      return (
        <div style={{
          backgroundColor: '#ffffff',
          border: '1px solid var(--border)',
          padding: 'var(--space-2) var(--space-3)',
          fontSize: 'var(--font-xs)',
          borderRadius: '4px'
        }}>
          <div><strong>Price:</strong> ₹{Number(point.price).toLocaleString('en-IN')}</div>
          <div><strong>Date:</strong> {new Date(point.timestamp).toLocaleString()}</div>
          {point.stockStatus && <div><strong>Stock:</strong> {point.stockStatus}</div>}
        </div>
      );
    }
    return null;
  };

  return (
    <div className="chart-wrapper">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-3)' }}>
        <h3 style={{ margin: 0 }}>Price History</h3>
        <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
          {ranges.map((r) => (
            <button
              key={r.value}
              type="button"
              className={`btn btn-sm ${activeRange === r.value ? 'btn-primary' : ''}`}
              onClick={() => onRangeChange(r.value)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {formattedData.length === 0 ? (
        <div style={{ padding: 'var(--space-5)', textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-sm)' }}>
          No historical price points recorded for this range.
        </div>
      ) : (
        <div style={{ width: '100%', height: 260 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={formattedData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
              <XAxis
                dataKey="dateLabel"
                stroke="var(--text-muted)"
                fontSize={12}
                tickLine={false}
              />
              <YAxis
                stroke="var(--text-muted)"
                fontSize={12}
                tickLine={false}
                tickFormatter={(val) => `₹${Number(val).toLocaleString('en-IN')}`}
                domain={['auto', 'auto']}
              />
              <Tooltip content={customTooltip} />
              <Line
                type="monotone"
                dataKey="price"
                stroke="var(--accent)"
                strokeWidth={2}
                dot={{ r: 3, fill: 'var(--accent)' }}
                activeDot={{ r: 5 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
