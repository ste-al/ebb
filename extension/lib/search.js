// Recognize search-results pages and compare queries.
// A search is the most reliable signal of a new task ("hunt"): the query names it.

const ENGINES = [
  { name: 'Google', host: /(^|\.)google\.[a-z]{2,3}(\.[a-z]{2})?$/, path: /^\/search\/?$/, params: ['q'] },
  { name: 'Google Scholar', host: /^scholar\.google\.[a-z]{2,3}(\.[a-z]{2})?$/, path: /^\/scholar\/?$/, params: ['q'] },
  { name: 'Bing', host: /(^|\.)bing\.com$/, path: /^\/search\/?$/, params: ['q'] },
  { name: 'DuckDuckGo', host: /(^|\.)duckduckgo\.com$/, path: /^\/(html\/?)?$/, params: ['q'] },
  { name: 'Brave Search', host: /^search\.brave\.com$/, path: /^\/search\/?$/, params: ['q'] },
  { name: 'Kagi', host: /(^|\.)kagi\.com$/, path: /^\/search\/?$/, params: ['q'] },
  { name: 'Ecosia', host: /(^|\.)ecosia\.org$/, path: /^\/search\/?$/, params: ['q'] },
  { name: 'Startpage', host: /(^|\.)startpage\.com$/, path: /^\/(do|sp)\/search\/?$/, params: ['query', 'q'] },
  { name: 'Yahoo', host: /(^|\.)search\.yahoo\.com$/, path: /^\/search\/?$/, params: ['p'] },
  { name: 'Yandex', host: /(^|\.)yandex\.[a-z]{2,3}$/, path: /^\/search\/?$/, params: ['text'] },
  { name: 'Baidu', host: /(^|\.)baidu\.com$/, path: /^\/s\/?$/, params: ['wd'] },
  { name: 'Seznam', host: /^search\.seznam\.cz$/, path: /^\/?$/, params: ['q'] },
  { name: 'Qwant', host: /(^|\.)qwant\.com$/, path: /^\/?$/, params: ['q'] },
  { name: 'Perplexity', host: /(^|\.)perplexity\.ai$/, path: /^\/search\/?/, params: ['q'] },
  { name: 'YouTube', host: /(^|\.)youtube\.com$/, path: /^\/results\/?$/, params: ['search_query'] },
  { name: 'Amazon', host: /(^|\.)amazon\.[a-z]{2,3}(\.[a-z]{2})?$/, path: /^\/s\/?$/, params: ['k'] },
  { name: 'eBay', host: /(^|\.)ebay\.[a-z]{2,3}(\.[a-z]{2})?$/, path: /^\/sch\//, params: ['_nkw'] },
  { name: 'Wikipedia', host: /\.wikipedia\.org$/, path: /^\/(w\/index\.php|wiki\/Special:Search)/, params: ['search'] },
  { name: 'GitHub', host: /^github\.com$/, path: /^\/search\/?$/, params: ['q'] },
  { name: 'Stack Overflow', host: /^stackoverflow\.com$/, path: /^\/search\/?$/, params: ['q'] },
  { name: 'Reddit', host: /(^|\.)reddit\.com$/, path: /^\/search\/?$/, params: ['q'] },
];

/**
 * Parse a URL into { engine, query } when it is a search-results page, else null.
 * @param {string} url
 */
export function parseSearch(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  for (const engine of ENGINES) {
    if (!engine.host.test(host) || !engine.path.test(u.pathname)) continue;
    for (const param of engine.params) {
      const raw = u.searchParams.get(param);
      const query = raw ? raw.replace(/\s+/g, ' ').trim() : '';
      if (query) return { engine: engine.name, query };
    }
  }
  return null;
}

// Short function words in English plus the languages Ebb's other patterns cover.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'at', 'by', 'with', 'is', 'are', 'be',
  'how', 'what', 'why', 'which', 'best', 'vs', 'do', 'does', 'my', 'me', 'from', 'about', 'near',
  'jak', 'na', 'pro', 'je', 'co', 'nebo', 've', 'se', 'do', 'od', 'za',
  'der', 'die', 'das', 'und', 'für', 'mit', 'im', 'ist', 'wie',
  'le', 'la', 'les', 'de', 'des', 'du', 'et', 'pour', 'avec',
  'el', 'los', 'las', 'y', 'en', 'con', 'por', 'para',
]);

/** Meaningful lower-case tokens of a query, accents folded. */
export function tokens(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Jaccard similarity of two queries' token sets, 0..1. */
export function similarity(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (A.size === 0 || B.size === 0) {
    return String(a).trim().toLowerCase() === String(b).trim().toLowerCase() ? 1 : 0;
  }
  let shared = 0;
  for (const t of A) if (B.has(t)) shared += 1;
  return shared / (A.size + B.size - shared);
}
