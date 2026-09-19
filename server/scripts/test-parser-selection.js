function extractPriceFromHtml(html) {
  // Find .price-main container
  const mainMatch = html.match(/<div class="price-main"[^>]*>([\s\S]*?)<\/div>/i);
  if (!mainMatch) return null;
  let inner = mainMatch[1];

  // 1. Strip display: none decoy elements
  inner = inner.replace(/<[^>]+style="[^"]*display:\s*none[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gi, '');

  // 2. Strip MRP (strikethrough) elements (.mr-*)
  inner = inner.replace(/<[^>]+class="[^"]*\bmr-[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gi, '');

  // 3. Strip Deal price elements (.sl-*)
  inner = inner.replace(/<[^>]+class="[^"]*\bsl-[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gi, '');

  // 4. Strip discount badge elements (.bd-*)
  inner = inner.replace(/<[^>]+class="[^"]*\bbd-[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gi, '');

  // 5. Strip "Updating…" or status indicators
  inner = inner.replace(/<span[^>]*>[^<]*updating[^<]*<\/span>/gi, '');

  // The remaining markup belongs exclusively to the active price element
  const cleanedText = inner.replace(/<[^>]+>/g, ' ').trim();
  return cleanedText;
}

const sampleHtml = `
  <h1>Test Product</h1>
  <div class="price-main">
    <span class="price-value" style="display: none;" aria-hidden="true">₹99,999</span>
    <span class="mr-m4" style="text-decoration: line-through;">₹21,532</span>
    <span class="sl-m4">Deal price ₹16,795</span>
    <span class="v0 pv-m4" style="font-size: 2.4rem;"><span>₹​</span><span>1​</span><span>2​</span><span>,​</span><span>0​</span><span>5​</span><span>8​</span></span>
    <span class="bd-m4">44% off</span>
  </div>
  <span class="stock-badge in-stock">In stock · 50 left</span>
`;

const text = extractPriceFromHtml(sampleHtml);
console.log('Extracted text:', JSON.stringify(text));

import { parsePriceText } from '../src/services/parser.js';
console.log('Parsed price:', parsePriceText(text));
