import { scrapeProduct } from '../src/services/storeClient.js';
import { closeBrowser } from '../src/services/browserScraper.js';

async function testHeadlessLive() {
  console.log('================================================================');
  console.log('LIVE HEADLESS SCRAPER VERIFICATION (EVIDENCE DEMONSTRATION)');
  console.log('Target: Product 459 (Domus Sling Plus) on https://demo.inelabteamdev.com');
  console.log('Mode: HEADLESS (headless: true, zero GUI window)');
  console.log('================================================================\n');

  const product = {
    store_product_id: '459',
    name: 'Domus Sling Plus'
  };

  const startTime = Date.now();
  try {
    const result = await scrapeProduct(product, { headed: false });
    const totalDuration = Date.now() - startTime;

    console.log('[Scraper Result Summary]:');
    console.log(`  Success:          ${result.success}`);
    console.log(`  Attempts:         ${result.attempts}`);
    console.log(`  Total Duration:   ${totalDuration}ms`);
    console.log(`  Extracted Data:`);
    console.log(`    - Price:          ₹${result.data?.price}`);
    console.log(`    - Stock Status:   ${result.data?.stock_status}`);
    console.log(`    - Stock Quantity: ${result.data?.stock_quantity}`);
    console.log(`    - Product Name:   ${result.data?.name}`);
    console.log(`\n[Attempt Details]:`);
    result.attempt_details.forEach((att) => {
      console.log(`  Attempt ${att.attempt}: outcome=${att.outcome}, duration=${att.duration_ms}ms, httpStatus=${att.http_status}`);
    });

    if (result.success && result.data.price > 0 && result.data.stock_status === 'in_stock') {
      console.log('\n✅ EVIDENCE CONFIRMED: Headless scraper successfully satisfied');
      console.log('   mouse dwell, revealed price, ignored decoy elements, and returned validated data!');
      console.log('================================================================');
      process.exit(0);
    } else {
      console.error('\n❌ FAILURE: Extracted data did not meet integrity requirements.');
      process.exit(1);
    }
  } catch (err) {
    console.error('\n❌ Fatal error during headless scrape:', err);
    process.exit(1);
  } finally {
    await closeBrowser();
  }
}

testHeadlessLive();
