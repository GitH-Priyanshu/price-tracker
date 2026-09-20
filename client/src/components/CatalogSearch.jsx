import React, { useState } from 'react';
import { searchCatalog } from '../api/client.js';

/**
 * Catalog search component: searches mock store by query and allows one-click tracking.
 */
export default function CatalogSearch({ onTrack, isTracking, trackedStoreIds = new Set() }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState(null);
  const [hasSearched, setHasSearched] = useState(false);

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!query.trim() || query.trim().length < 2) {
      setError('Search term must be at least 2 characters long.');
      return;
    }

    setIsSearching(true);
    setError(null);
    try {
      const data = await searchCatalog(query.trim());
      setResults(data.products || []);
      setHasSearched(true);
    } catch (err) {
      setError(err.message || 'Search failed');
    } finally {
      setIsSearching(false);
    }
  };

  return (
    <div>
      <form onSubmit={handleSearch} style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-3)' }}>
        <input
          type="search"
          placeholder="Search catalog (e.g. sling, soundbar, monitor, dock)..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search catalog query"
        />
        <button type="submit" className="btn btn-primary" disabled={isSearching}>
          {isSearching ? 'Searching...' : 'Search'}
        </button>
      </form>

      {error && <div className="alert alert-error">{error}</div>}

      {hasSearched && (
        <>
          {results.length === 0 ? (
            <p style={{ color: 'var(--text-muted)', fontSize: 'var(--font-sm)' }}>
              No catalog products matched "{query}".
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Store ID</th>
                  <th>Product</th>
                  <th>Category</th>
                  <th>Catalog Price</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {results.map((item) => {
                  const isTracked = trackedStoreIds.has(String(item.id));
                  return (
                    <tr key={item.id}>
                      <td className="mono">{item.id}</td>
                      <td>
                        <strong>{item.name}</strong>
                        {item.brand && <span style={{ color: 'var(--text-muted)' }}> ({item.brand})</span>}
                      </td>
                      <td>{item.category || '—'}</td>
                      <td>
                        ₹{(item.price || 0).toLocaleString('en-IN')}
                        {item.mrp && (
                          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-xs)', marginLeft: 'var(--space-1)' }}>
                            (MRP ₹{item.mrp.toLocaleString('en-IN')})
                          </span>
                        )}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          onClick={() => onTrack(item.id, { name: item.name, category: item.category, brand: item.brand, sku: item.sku })}
                          disabled={isTracked || isTracking === String(item.id)}
                        >
                          {isTracked ? 'Tracked' : (isTracking === String(item.id) ? 'Tracking...' : 'Track')}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
