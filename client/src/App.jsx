import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import Navbar from './components/Navbar.jsx';
import ServerWakeNotice from './components/ServerWakeNotice.jsx';
import ProductsPage from './pages/ProductsPage.jsx';
import ProductDetailPage from './pages/ProductDetailPage.jsx';

export default function App() {
  return (
    <Router>
      <Navbar />
      <div className="app-container">
        <ServerWakeNotice />
        <Routes>
          <Route path="/" element={<ProductsPage />} />
          <Route path="/track" element={<ProductsPage />} />
          <Route path="/products/:id" element={<ProductDetailPage />} />
        </Routes>
      </div>
    </Router>
  );
}
