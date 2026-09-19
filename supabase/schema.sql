-- ============================================================================
-- PRODUCT PRICE TRACKER: CORE SCHEMA (Phase 1)
-- Run this SQL in the Supabase SQL Editor.
-- Contains CORE tables only: products, price_history, scrape_logs.
-- Row Level Security (RLS) enabled on all tables with NO public policies.
-- Access is restricted exclusively to the backend using the service-role key.
-- ============================================================================

-- Ensure pgcrypto extension is available for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ----------------------------------------------------------------------------
-- 1. PRODUCTS TABLE
-- Holds the metadata and current tracking state of each monitored product.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_product_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    url TEXT,
    image_url TEXT,
    category TEXT,
    brand TEXT,
    sku TEXT,
    description TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    last_scraped_at TIMESTAMPTZ,
    last_status TEXT CHECK (last_status IN ('success', 'retried', 'failed') OR last_status IS NULL),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for quickly retrieving all active products for scrape cycles
CREATE INDEX IF NOT EXISTS idx_products_active ON products(is_active) WHERE is_active = true;

-- ----------------------------------------------------------------------------
-- 2. PRICE_HISTORY TABLE
-- Stores ONLY validated, successful scrapes. Never empty/placeholder/failed.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS price_history (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    price NUMERIC(12, 2) NOT NULL CHECK (price > 0),
    stock_status TEXT NOT NULL CHECK (stock_status IN ('in_stock', 'out_of_stock')),
    stock_quantity INT CHECK (stock_quantity >= 0 OR stock_quantity IS NULL),
    scraped_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Compound index for fast chronological price charting and history retrieval
CREATE INDEX IF NOT EXISTS idx_price_history_product_scraped ON price_history(product_id, scraped_at DESC);

-- ----------------------------------------------------------------------------
-- 3. SCRAPE_LOGS TABLE
-- Records every scrape run honestly: success (1 attempt), retried (>1 attempts),
-- or failed (all attempts exhausted).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scrape_logs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    run_id UUID NOT NULL,
    started_at TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('success', 'retried', 'failed')),
    attempts INT NOT NULL CHECK (attempts >= 1),
    http_status INT,
    error_type TEXT CHECK (error_type IN (
        'NETWORK',
        'TIMEOUT',
        'HTTP_5XX',
        'HTTP_4XX',
        'RATE_LIMITED',
        'PLACEHOLDER',
        'PARSE_ERROR',
        'VALIDATION',
        'IDENTITY_MISMATCH'
    ) OR error_type IS NULL),
    error_message TEXT,
    duration_ms INT NOT NULL CHECK (duration_ms >= 0),
    attempt_details JSONB NOT NULL DEFAULT '[]'::jsonb,
    price_history_id BIGINT REFERENCES price_history(id) ON DELETE SET NULL
);

-- Compound index for displaying chronological scrape logs per product
CREATE INDEX IF NOT EXISTS idx_scrape_logs_product_started ON scrape_logs(product_id, started_at DESC);

-- ----------------------------------------------------------------------------
-- 4. ROW LEVEL SECURITY (RLS)
-- Enable RLS on all core tables. With NO policies added, public/anon access
-- is completely rejected. Only the service-role key (used by backend) can
-- read and write these tables.
-- ----------------------------------------------------------------------------
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE scrape_logs ENABLE ROW LEVEL SECURITY;
