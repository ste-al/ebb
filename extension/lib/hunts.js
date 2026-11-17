// Hunts: automatic task clusters. A hunt starts with a search (named by its query)
// or with a page you navigate to yourself (named by its site). Tabs opened from a
// tab in a hunt join that hunt. No manual grouping, ever.

import { similarity } from './search.js';
import { hostOf } from './util.js';

/** Navigations the user started directly, which begin a new hunt unless it's the same site. */
const USER_STARTED = new Set(['typed', 'auto_bookmark', 'generated', 'keyword', 'keyword_generated', 'start_page']);

/**
 * Decide what a committed main-frame navigation does to the tab's hunt.
 * @param {object} p
 * @param {object|null} p.current  the tab's current hunt
 * @param {string} p.url
 * @param {string} p.transition  webNavigation transitionType
 * @param {{engine:string, query:string}|null} p.search  parsed search, if this is a results page
 * @param {boolean} p.refining  the tab searched recently (a query edited on the results page)
 * @returns {{action:'keep'|'new', addQuery?:string, hunt?:object}}
 */
export function decideHunt({ current, url, transition, search, refining = false }) {
  const host = hostOf(url);
  if (search) {
    if (current && current.origin === 'search' && current.queries?.length) {
      const best = Math.max(...current.queries.map((q) => similarity(q, search.query)));
      if (best >= (refining ? 0.25 : 0.5)) return { action: 'keep', addQuery: search.query };
    }
    return {
      action: 'new',
      hunt: { origin: 'search', name: search.query, engine: search.engine, queries: [search.query], host },
    };
  }
  if (!current) return { action: 'new', hunt: { origin: 'site', name: host, host, queries: [] } };
  if (USER_STARTED.has(transition)) {
    if (current.origin === 'site' && current.host === host) return { action: 'keep' };
    return { action: 'new', hunt: { origin: 'site', name: host, host, queries: [] } };
  }
  return { action: 'keep' };
}

/** Display name: the latest query for search hunts, the site otherwise. */
export function huntLabel(hunt) {
  if (!hunt) return 'Loose tabs';
  if (hunt.origin === 'search' && hunt.queries?.length) return hunt.queries[hunt.queries.length - 1];
  return hunt.name || hunt.host || 'Loose tabs';
}
