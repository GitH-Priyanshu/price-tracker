# Test Fixtures Index & Classifications

This directory contains representative raw responses and DOM states used for testing the fetcher, parser, and validator pipelines offline without hitting the mock store.

| Fixture File | Type | Source / Description |
| :--- | :---: | :--- |
| `catalog_page_1.json` | **REAL** | Live HTTP response from `https://demo.inelabteamdev.com/api/catalog?page=1&pageSize=20`. Captures the authentic shape of 20 catalog products with pagination metadata. |
| `product_459_metadata.json` | **REAL** | Live HTTP response from `https://demo.inelabteamdev.com/api/product/459`. Contains static specs, SKU, brand, and description (excludes price and stock). |
| `layout.json` | **REAL** | Live HTTP response from `https://demo.inelabteamdev.com/api/layout`. Contains dynamic layout configuration, rotated class names, and active price tags. |
| `product_normal_revealed.html` | **REAL** | Fully rendered HTML DOM of product 459 captured via Playwright in headless mode after mouse movement and price reveal. Contains real visible price and stock badge alongside decoy elements. |
| `product_loading_placeholder.html` | **REAL** | Rendered HTML DOM of product 459 captured immediately upon DOM mount before mouse dwell and reveal. Displays `"Price hidden"` and `"Hover over the price area to load the current price."` |
| `product_error_page.html` | **REAL** | Rendered HTML DOM captured when visiting an invalid product ID (`https://demo.inelabteamdev.com/product/999999`) which triggers a 404 client state. |
| `product_structure_shift.html` | **SYNTHETIC** | Synthesized mutation based on `product_normal_revealed.html` where `.price-main` is renamed and price tags are stripped, simulating an unannounced markup change by the store. |
