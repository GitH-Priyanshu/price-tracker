import React, { useState } from 'react';
import { searchCatalog } from '../api/client.js';
import StatusPill from './StatusPill.jsx';

/**
 * Catalog search component: searches mock store by query and allows one-click tracking.
 */
export default function CatalogSearch({ onTrack, isTracking, trackedStoreIds = new Set() }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState(null);
  const [hasSearched, setHasSearched] = useState(false);
  const RESULT_CAP = 30;

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

  const displayedResults = results.slice(0, RESULT_CAP);

  return (
    <div>
      <form onSubmit={handleSearch} style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-3)' }}>
        <input
          type="search"
          placeholder="Search catalog (e.g. domus, sling, soundbar, 459)..."
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
            <>
              <p style={{ color: 'var(--text-muted)', fontSize: 'var(--font-xs)', marginBottom: 'var(--space-2)' }}>
                Showing {displayedResults.length} of {results.length} results
              </p>
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
                  {displayedResults.map((item) => {
                    const storeId = String(item.store_product_id || item.id || '');
                    const isTracked = trackedStoreIds.has(storeId);
                    const isCurrentTracking = isTracking === storeId;

                    return (
                      <tr key={storeId}>
                        <td className="mono" style={{ fontWeight: 600 }}>{storeId}</td>
                        <td>
                          <strong>{item.name}</strong>
                          {item.brand && <span style={{ color: 'var(--text-muted)' }}> ({item.brand})</span>}
                          {isTracked && (
                            <span style={{ marginLeft: 'var(--space-2)' }}>
                              <StatusPill status="tracking" />
                            </span>
                          )}
                        </td>
                        <td>{item.category || '-'}</td>
                        <td>
                          {item.price != null && item.price > 0
                            ? `₹${Number(item.price).toLocaleString('en-IN')}`
                            : '-'}
                          {item.mrp != null && item.mrp > 0 && (
                            <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-xs)', marginLeft: 'var(--space-1)' }}>
                              (MRP ₹{Number(item.mrp).toLocaleString('en-IN')})
                            </span>
                          )}
                        </td>
                        <td>
                          {isTracked ? (
                            <span className="pill pill-success" style={{ fontWeight: 600 }}>
                              Tracking
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="btn btn-sm btn-primary"
                              onClick={() => onTrack(storeId, { name: item.name, category: item.category, brand: item.brand, sku: item.sku })}
                              disabled={isCurrentTracking}
                            >
                              {isCurrentTracking ? 'Tracking...' : 'Track'}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </div>
  );
}
