import React from 'react';
import { Link, useLocation } from 'react-router-dom';

export default function Navbar() {
  const location = useLocation();

  return (
    <header className="navbar">
      <div className="navbar-inner">
        <Link to="/" className="navbar-brand">
          Price Tracker
        </Link>
        <nav>
          <ul className="navbar-nav">
            <li>
              <Link
                to="/"
                className={`nav-link ${location.pathname === '/' ? 'active' : ''}`}
              >
                Tracked Products
              </Link>
            </li>
            <li>
              <Link
                to="/track"
                className={`nav-link ${location.pathname === '/track' ? 'active' : ''}`}
              >
                Track New
              </Link>
            </li>
          </ul>
        </nav>
      </div>
    </header>
  );
}
