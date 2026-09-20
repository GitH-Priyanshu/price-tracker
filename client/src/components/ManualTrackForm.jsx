import React, { useState } from 'react';

/**
 * Direct product tracking form (by store product ID or full store URL).
 */
export default function ManualTrackForm({ onTrack, isTracking }) {
  const [inputVal, setInputVal] = useState('');
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const val = inputVal.trim();
    if (!val) {
      setError('Please enter a valid numeric store product ID (e.g. 459) or product URL.');
      return;
    }

    let parsedId = val;
    if (val.includes('product/')) {
      const match = val.match(/product\/([a-zA-Z0-9_-]+)/);
      if (match) parsedId = match[1];
    }

    if (!/^\d+$/.test(parsedId)) {
      setError(`Product ID must be numeric (e.g. 459), received "${parsedId}".`);
      return;
    }

    setError(null);
    const res = await onTrack(val);
    if (res && res.ok === false) {
      setError(res.error || 'Failed to track product.');
    } else {
      setInputVal('');
    }
  };

  return (
    <form onSubmit={handleSubmit} style={{ marginBottom: 'var(--space-4)' }}>
      <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          placeholder="Enter Store Product ID (digits only, e.g. 459)"
          value={inputVal}
          onChange={(e) => {
            const digits = e.target.value.replace(/\D/g, '');
            setInputVal(digits);
            if (error) setError(null);
          }}
          style={error ? { borderColor: 'var(--status-failed)' } : {}}
          aria-label="Store product ID (digits only)"
          aria-invalid={Boolean(error)}
        />
        <button type="submit" className="btn btn-primary" disabled={isTracking}>
          {isTracking ? 'Tracking...' : 'Track Product'}
        </button>
      </div>
      {error && (
        <div
          className="alert alert-error"
          style={{ marginTop: 'var(--space-2)', padding: 'var(--space-2) var(--space-3)', fontSize: 'var(--font-xs)' }}
        >
          {error}
        </div>
      )}
    </form>
  );
}
