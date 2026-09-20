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

  // Chronological sort
  const sorted = [...history].sort((a, b) => {
    const tA = new Date(a.scraped_at || a.recorded_at || a.created_at).getTime();
    const tB = new Date(b.scraped_at || b.recorded_at || b.created_at).getTime();
    return tA - tB;
  });

  // Track day changes to only show the date when the day transitions
  let lastDayStr = null;
  const labelMap = {};

  const formattedData = sorted.map((item, index) => {
    const ts = item.scraped_at || item.recorded_at || item.created_at;
    const d = new Date(ts);
    const dayStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const timeStr = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

    const isNewDay = index === 0 || dayStr !== lastDayStr;
    if (isNewDay) {
      lastDayStr = dayStr;
    }

    const label = isNewDay ? `${dayStr}, ${timeStr}` : timeStr;
    labelMap[ts] = label;

    return {
      timestamp: ts,
      dateLabel: label,
      price: item.price,
      stockStatus: item.stock_status
    };
  });

  const customTooltip = ({ active, payload }) => {
    if (active && payload && payload.length) {
      const point = payload[0].payload;
      const formattedTimestamp = new Date(point.timestamp).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
      });
      const stockText = point.stockStatus === 'in_stock'
        ? 'In Stock'
        : point.stockStatus === 'out_of_stock'
        ? 'Out of Stock'
        : (point.stockStatus || 'Unknown');

      return (
        <div style={{
          backgroundColor: '#ffffff',
          border: '1px solid var(--border)',
          padding: 'var(--space-2) var(--space-3)',
          fontSize: 'var(--font-xs)',
          borderRadius: '4px',
          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.08)'
        }}>
          <div><strong>Price:</strong> ₹{Number(point.price).toLocaleString('en-IN')}</div>
          <div><strong>Timestamp:</strong> {formattedTimestamp}</div>
          <div><strong>Stock Status:</strong> {stockText}</div>
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
                dataKey="timestamp"
                tickFormatter={(ts) => labelMap[ts] || ts}
                stroke="var(--text-muted)"
                fontSize={12}
                tickLine={false}
                interval="preserveStartEnd"
                minTickGap={35}
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
                type="linear"
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
