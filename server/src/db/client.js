import { createClient } from '@supabase/supabase-js';
import config, { validateConfig } from '../config/index.js';

let supabaseClient = null;

/**
 * Returns the initialized Supabase service-role client singleton.
 * Validates that SUPABASE_URL and SUPABASE_SERVICE_KEY exist before initializing.
 */
export function getSupabaseClient() {
  if (!supabaseClient) {
    validateConfig({ requireDb: true });
    supabaseClient = createClient(config.supabaseUrl, config.supabaseServiceKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });
  }
  return supabaseClient;
}

export default getSupabaseClient;
