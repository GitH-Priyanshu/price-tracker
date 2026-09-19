import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load .env if present
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const config = {
  // Database (Supabase)
  supabaseUrl: (process.env.SUPABASE_URL || '').trim().replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, ''),
  supabaseServiceKey: (process.env.SUPABASE_SERVICE_KEY || '').trim(),

  // Authentication & Security
  cronSecret: process.env.CRON_SECRET || '',
  frontendOrigin: process.env.FRONTEND_ORIGIN || 'http://localhost:5173',

  // Network & Mock Store
  port: parseInt(process.env.PORT || '3000', 10),
  storeBaseUrl: process.env.STORE_BASE_URL || 'https://demo.inelabteamdev.com',

  // Scraping Budgets & Concurrency (Evidence-based: p95 reveal is 17.4s; 18s cuts off deadlocks while allowing p95)
  requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS || '18000', 10),
  maxAttempts: parseInt(process.env.MAX_ATTEMPTS || '3', 10),
  scrapeConcurrency: parseInt(process.env.SCRAPE_CONCURRENCY || '1', 10),
  dedupeWindowMinutes: parseInt(process.env.DEDUPE_WINDOW_MINUTES || '10', 10),

  // Environment
  nodeEnv: process.env.NODE_ENV || 'development'
};

/**
 * Validates configuration parameters.
 * Fails fast with clear actionable messages when required variables are missing.
 * @param {Object} options
 * @param {boolean} [options.requireDb=false] - Whether Supabase credentials are required
 * @param {boolean} [options.requireCron=false] - Whether CRON_SECRET is required
 */
export function validateConfig(options = {}) {
  const { requireDb = false, requireCron = false } = options;
  const missing = [];

  if (requireDb) {
    if (!config.supabaseUrl) missing.push('SUPABASE_URL');
    if (!config.supabaseServiceKey) missing.push('SUPABASE_SERVICE_KEY');
  }

  if (requireCron && !config.cronSecret) {
    missing.push('CRON_SECRET');
  }

  if (missing.length > 0) {
    const errorMsg = `[Config Error] Missing required environment variables: ${missing.join(', ')}.\n` +
      `Please check server/.env (see server/.env.example for template).`;
    throw new Error(errorMsg);
  }

  // Validate numeric ranges
  if (isNaN(config.port) || config.port <= 0 || config.port > 65535) {
    throw new Error(`[Config Error] Invalid PORT: ${process.env.PORT}`);
  }
  if (isNaN(config.requestTimeoutMs) || config.requestTimeoutMs < 1000) {
    throw new Error(`[Config Error] REQUEST_TIMEOUT_MS must be at least 1000ms`);
  }
  if (isNaN(config.maxAttempts) || config.maxAttempts < 1) {
    throw new Error(`[Config Error] MAX_ATTEMPTS must be at least 1`);
  }
  if (isNaN(config.scrapeConcurrency) || config.scrapeConcurrency < 1) {
    throw new Error(`[Config Error] SCRAPE_CONCURRENCY must be at least 1`);
  }
  if (isNaN(config.dedupeWindowMinutes) || config.dedupeWindowMinutes < 1) {
    throw new Error(`[Config Error] DEDUPE_WINDOW_MINUTES must be at least 1`);
  }

  return true;
}

export default config;
