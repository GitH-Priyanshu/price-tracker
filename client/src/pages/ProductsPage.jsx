import React, { useState, useEffect } from 'react';
import ProductTable from '../components/ProductTable.jsx';
import CatalogSearch from '../components/CatalogSearch.jsx';
import ManualTrackForm from '../components/ManualTrackForm.jsx';
import { getProducts, trackProduct, deactivateProduct } from '../api/client.js';

export default function ProductsPage() {
  const [products, setProducts] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [isTracking, setIsTracking] = useState(false);
  const [isDeactivating, setIsDeactivating] = useState(null);

  const loadProducts = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await getProducts();
      setProducts(data);
    } catch (err) {
      setError(err.message || 'Failed to load tracked products');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadProducts();
  }, []);

  const handleTrack = async (storeProductId, overrides = {}) => {
    setIsTracking(String(storeProductId));
    setFeedback(null);
    setError(null);
    try {
      await trackProduct(storeProductId, overrides);
      setFeedback(`Product ${storeProductId} added to tracking successfully.`);
      await loadProducts();
      return { ok: true };
    } catch (err) {
      const msg = err.message || 'Failed to track product';
      setError(msg);
      return { ok: false, error: msg };
    } finally {
      setIsTracking(false);
    }
  };

  const handleDeactivate = async (id) => {
    if (!window.confirm('Are you sure you want to stop tracking this product?')) {
      return;
    }
    setIsDeactivating(id);
    setFeedback(null);
    setError(null);
    try {
      await deactivateProduct(id);
      setFeedback('Product untracked successfully.');
      await loadProducts();
    } catch (err) {
      setError(err.message || 'Failed to deactivate product');
    } finally {
      setIsDeactivating(null);
    }
  };

  const trackedStoreIds = new Set(products.map((p) => String(p.store_product_id)));

  return (
    <main>
      <h1>Tracked Products</h1>

      {feedback && <div className="alert alert-success">{feedback}</div>}
      {error && <div className="alert alert-error">{error}</div>}

      {isLoading ? (
        <p style={{ color: 'var(--text-muted)' }}>Loading tracked products...</p>
      ) : (
        <ProductTable
          products={products}
          onDeactivate={handleDeactivate}
          isDeactivating={isDeactivating}
        />
      )}

      <h2>Track New Product</h2>
      <p style={{ color: 'var(--text-muted)', fontSize: 'var(--font-sm)', marginBottom: 'var(--space-3)' }}>
        Track by entering a store product ID or URL directly:
      </p>
      <ManualTrackForm onTrack={handleTrack} isTracking={Boolean(isTracking)} />

      <h2>Search Mock Store Catalog</h2>
      <p style={{ color: 'var(--text-muted)', fontSize: 'var(--font-sm)', marginBottom: 'var(--space-3)' }}>
        Search for products from the mock store catalog to track:
      </p>
      <CatalogSearch
        onTrack={handleTrack}
        isTracking={isTracking}
        trackedStoreIds={trackedStoreIds}
      />
    </main>
  );
}
