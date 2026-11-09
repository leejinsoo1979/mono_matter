/** This function is intentionally self-contained: Chrome runs it only after the user clicks Extract. */
export function extractProduct() {
  const clean = (value, max = 20000) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
  const safeUrl = (value, source = false) => {
    if (typeof value !== 'string' || !value.trim()) return '';
    try {
      const url = new URL(value, location.href);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
      url.hash = '';
      if (source) url.search = '';
      else {
        // Only rendering parameters are retained; auth/signature/session parameters are never captured.
        const imageParameters = new Set(['w', 'width', 'h', 'height', 'q', 'quality', 'fit', 'crop', 'auto', 'fm', 'format', 'dpr', 'bg', 'pad']);
        for (const key of [...url.searchParams.keys()]) if (!imageParameters.has(key.toLowerCase())) url.searchParams.delete(key);
      }
      return url.href;
    } catch { return ''; }
  };
  const sourceUrl = safeUrl(location.href, true);
  if (!sourceUrl) throw new Error('Open an http or https product page before extracting.');
  const meta = names => {
    for (const name of names) {
      const node = document.querySelector(`meta[property="${name}"], meta[name="${name}"]`);
      const value = clean(node?.getAttribute('content'));
      if (value) return value;
    }
    return '';
  };
  let product = null;
  const inspect = (value, depth = 0) => {
    if (!value || depth > 6 || product) return;
    if (Array.isArray(value)) { for (const item of value.slice(0, 100)) inspect(item, depth + 1); return; }
    if (typeof value !== 'object') return;
    const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
    if (types.some(type => type === 'Product' || type === 'https://schema.org/Product')) { product = value; return; }
    if (value['@graph']) inspect(value['@graph'], depth + 1);
    if (value.mainEntity) inspect(value.mainEntity, depth + 1);
    if (value.itemListElement) inspect(value.itemListElement, depth + 1);
    if (value.item) inspect(value.item, depth + 1);
  };
  for (const script of [...document.querySelectorAll('script[type="application/ld+json"]')].slice(0, 30)) {
    if (script.textContent.length > 200000) continue;
    try { inspect(JSON.parse(script.textContent)); } catch { /* Invalid structured data is ignored. */ }
    if (product) break;
  }
  const offer = Array.isArray(product?.offers) ? product.offers[0] : product?.offers;
  const priceNode = document.querySelector('[itemprop="price"]');
  const priceText = offer?.price ?? offer?.lowPrice ?? meta(['product:price:amount', 'og:price:amount']) ?? '';
  const rawPrice = String(priceText || priceNode?.getAttribute('content') || clean(priceNode?.textContent, 100)).replace(/[^\d.,-]/g, '');
  const parsedPrice = rawPrice.includes(',') && !rawPrice.includes('.') && /,\d{2}$/.test(rawPrice) ? Number(rawPrice.replace(',', '.')) : Number(rawPrice.replace(/,/g, ''));
  const rawImage = Array.isArray(product?.image) ? product.image[0] : product?.image;
  const image = safeUrl((typeof rawImage === 'object' ? rawImage?.url : rawImage) || meta(['og:image', 'twitter:image']));
  const brand = typeof product?.brand === 'string' ? product.brand : product?.brand?.name;
  const result = {
    name: clean(product?.name || document.querySelector('h1')?.textContent || meta(['og:title', 'twitter:title']) || document.title, 500),
    brand: clean(brand || meta(['product:brand', 'brand']), 300),
    image,
    description: clean(product?.description || meta(['og:description', 'description'])),
    sourceUrl,
  };
  if (rawPrice && Number.isFinite(parsedPrice) && parsedPrice >= 0) result.price = parsedPrice;
  const currency = clean(offer?.priceCurrency || meta(['product:price:currency', 'og:price:currency']), 10);
  if (currency) result.currency = currency;
  const category = clean(product?.category || meta(['product:category']), 300);
  if (category) result.category = category;
  return result;
}

export function safeWebUrl(value) {
  if (!value) return '';
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; } catch { return ''; }
}

export function workspaceClipUrl(workspace, product) {
  const safe = safeWebUrl(workspace);
  if (!safe) throw new Error('Use an http or https workspace address.');
  const url = new URL(safe);
  url.search = ''; url.hash = '';
  url.pathname = `${url.pathname.replace(/\/clip\/?$/, '').replace(/\/$/, '')}/clip`;
  url.hash = encodeURIComponent(JSON.stringify(product));
  return url.href;
}
