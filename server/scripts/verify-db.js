import config, { validateConfig } from '../src/config/index.js';
import { getSupabaseClient } from '../src/db/client.js';

async function verifyDatabase() {
  console.log('================================================================');
  console.log('SUPABASE DATABASE CONNECTION & SCHEMA VERIFICATION');
  console.log('================================================================');

  try {
    validateConfig({ requireDb: true });
    console.log(`[Config] Target URL: ${config.supabaseUrl}`);
    console.log(`[Config] Service Key: ${config.supabaseServiceKey ? '[Present]' : '[Missing]'}`);
  } catch (err) {
    console.error('\n[Error] Configuration check failed:');
    console.error(err.message);
    process.exit(1);
  }

  const supabase = getSupabaseClient();
  const tables = ['products', 'price_history', 'scrape_logs'];
  let allHealthy = true;

  console.log('\nTesting table access with service role key:');

  for (const table of tables) {
    try {
      // Select with exact count and limit 1 to force PostgREST schema verification and get count
      const { data, error, count } = await supabase
        .from(table)
        .select('*', { count: 'exact' })
        .limit(1);

      if (error) {
        console.error(`  ❌ Table '${table}': FAILED - ${error.message} (Code: ${error.code})`);
        allHealthy = false;
      } else {
        console.log(`  ✅ Table '${table}': OK (Current row count: ${count != null ? count : 0})`);
      }
    } catch (e) {
      console.error(`  ❌ Table '${table}': UNEXPECTED ERROR - ${e.message}`);
      allHealthy = false;
    }
  }

  console.log('\n----------------------------------------------------------------');
  if (allHealthy) {
    console.log('STATUS: ALL CORE TABLES EXIST AND ARE REACHABLE VIA SERVICE ROLE!');
    console.log('Database verification succeeded.');
    console.log('================================================================');
    process.exit(0);
  } else {
    console.log('STATUS: VERIFICATION FAILED.');
    console.log('Please ensure you have executed /supabase/schema.sql in the Supabase SQL Editor.');
    console.log('================================================================');
    process.exit(1);
  }
}

verifyDatabase().catch((e) => {
  console.error('Fatal verification error:', e);
  process.exit(1);
});
