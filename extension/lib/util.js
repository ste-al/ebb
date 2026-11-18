// Small shared helpers. No browser APIs here, so everything is unit-testable.

export const SEC = 1000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/** Hostname without a leading "www.", lower-cased. Empty string for invalid URLs. */
export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/** True for pages Ebb may manage: http(s) only. */
export function isWebUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

const TRACKING_PARAM = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref_src|ref_url|_hsenc|_hsmi|si)$/i;

/**
 * URL without its fragment and common tracking parameters, used to tell whether two
 * addresses are the same page. Fragments that are app routes (#/inbox, #!/item) are kept.
 */
export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    if (!/^#!?\//.test(u.hash)) u.hash = '';
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAM.test(key)) u.searchParams.delete(key);
    }
    return u.toString();
  } catch {
    return url || '';
  }
}

/** A readable fallback title for a URL: host plus a shortened path. */
export function prettyUrl(url) {
  try {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname).replace(/\/$/, '');
    const short = path.length > 48 ? path.slice(0, 47) + '…' : path;
    return u.hostname.replace(/^www\./, '') + short;
  } catch {
    return url || '';
  }
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/** Human duration for UI copy: 45s, 12m, 3h, 2d. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '';
  const abs = Math.abs(ms);
  if (abs < MIN) return `${Math.max(1, Math.round(abs / SEC))}s`;
  if (abs < HOUR) return `${Math.round(abs / MIN)}m`;
  if (abs < DAY) return `${Math.round(abs / HOUR)}h`;
  return `${Math.round(abs / DAY)}d`;
}

/** Truncate text on a word boundary. */
export function excerpt(text, max = 600) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut) + '…';
}
