// Classify a page by what it usually is, so lifetimes follow meaning:
// web apps never expire, news and search results fade fast, references and documents last longer.

import { hostOf, isWebUrl } from './util.js';
import { parseSearch } from './search.js';

/** Hosts people keep open as tools. Ebb never tidies these. */
export const APP_HOSTS = [
  'mail.google.com', 'calendar.google.com', 'meet.google.com', 'chat.google.com', 'keep.google.com',
  'outlook.office.com', 'outlook.office365.com', 'outlook.live.com', 'teams.microsoft.com', 'teams.live.com',
  'app.slack.com', 'web.whatsapp.com', 'web.telegram.org', 'discord.com', 'messenger.com',
  'chatgpt.com', 'chat.openai.com', 'claude.ai', 'gemini.google.com',
  'music.youtube.com', 'open.spotify.com', 'app.asana.com', 'linear.app', 'trello.com', 'app.todoist.com',
  'mail.proton.me', 'app.fastmail.com', 'mail.yahoo.com', 'email.seznam.cz', 'mail.zoho.com',
];

const DOC_HOSTS = [
  'docs.google.com', 'drive.google.com', 'notion.so', 'figma.com', 'miro.com', 'airtable.com',
  'github.com', 'gitlab.com', 'bitbucket.org', 'onedrive.live.com', 'dropbox.com', 'overleaf.com',
];
const DOC_SUFFIXES = ['.notion.site', '.atlassian.net', '.sharepoint.com', '.gitbook.io'];

const REFERENCE_HOSTS = [
  'developer.mozilla.org', 'stackoverflow.com', 'learn.microsoft.com', 'developer.apple.com',
  'developer.android.com', 'developer.chrome.com', 'pkg.go.dev', 'docs.rs', 'npmjs.com', 'pypi.org',
  'man7.org', 'cppreference.com', 'en.cppreference.com', 'w3.org', 'whatwg.org', 'caniuse.com',
  'wikipedia.org', 'arxiv.org', 'scholar.google.com',
];
const REFERENCE_SUFFIXES = ['.wikipedia.org', '.stackexchange.com', '.readthedocs.io', '.mozilla.org'];

const NEWS_HOSTS = [
  'news.ycombinator.com', 'bbc.com', 'bbc.co.uk', 'cnn.com', 'nytimes.com', 'theguardian.com', 'reuters.com',
  'apnews.com', 'bloomberg.com', 'washingtonpost.com', 'wsj.com', 'ft.com', 'economist.com', 'theverge.com',
  'arstechnica.com', 'techcrunch.com', 'wired.com', 'engadget.com', 'theatlantic.com', 'politico.com',
  'idnes.cz', 'novinky.cz', 'seznamzpravy.cz', 'irozhlas.cz', 'aktualne.cz', 'denik.cz', 'lidovky.cz',
  'ct24.ceskatelevize.cz', 'e15.cz', 'hn.cz', 'respekt.cz', 'spiegel.de', 'zeit.de', 'faz.net',
  'lemonde.fr', 'elpais.com', 'corriere.it',
];

const SOCIAL_HOSTS = [
  'reddit.com', 'old.reddit.com', 'x.com', 'twitter.com', 'facebook.com', 'instagram.com', 'linkedin.com',
  'threads.net', 'bsky.app', 'mastodon.social', 'tiktok.com', 'pinterest.com', 'tumblr.com', 'lobste.rs',
];

const VIDEO_HOSTS = ['youtube.com', 'm.youtube.com', 'youtu.be', 'vimeo.com', 'twitch.tv', 'netflix.com', 'dailymotion.com'];

const SHOPPING_HOSTS = [
  'ebay.com', 'etsy.com', 'aliexpress.com', 'alza.cz', 'mall.cz', 'heureka.cz', 'czc.cz', 'datart.cz',
  'zalando.com', 'ikea.com', 'booking.com', 'airbnb.com', 'expedia.com', 'kayak.com', 'skyscanner.net',
  'bestbuy.com', 'walmart.com', 'target.com', 'temu.com', 'shein.com',
];

function hostIn(host, list, suffixes = []) {
  if (list.includes(host)) return true;
  if (list.some((h) => host.endsWith('.' + h))) return true;
  return suffixes.some((s) => host.endsWith(s));
}

/**
 * @param {string} url
 * @returns {'app'|'search'|'doc'|'reference'|'news'|'social'|'video'|'shopping'|'other'|'internal'}
 */
export function classify(url) {
  if (!isWebUrl(url)) return 'internal';
  const host = hostOf(url);
  if (hostIn(host, APP_HOSTS)) return 'app';
  if (parseSearch(url)) return 'search';
  if (/^(amazon|ebay)\.[a-z.]+$/.test(host)) return 'shopping';
  if (hostIn(host, VIDEO_HOSTS)) return 'video';
  if (hostIn(host, DOC_HOSTS, DOC_SUFFIXES)) return 'doc';
  if (host.startsWith('docs.') || hostIn(host, REFERENCE_HOSTS, REFERENCE_SUFFIXES)) return 'reference';
  if (host.startsWith('news.') || hostIn(host, NEWS_HOSTS)) return 'news';
  if (hostIn(host, SOCIAL_HOSTS)) return 'social';
  if (hostIn(host, SHOPPING_HOSTS)) return 'shopping';
  return 'other';
}

/** True when the user listed this host (or a parent domain) as never-tidy. */
export function isExempt(url, exemptHosts = []) {
  const host = hostOf(url);
  if (!host) return false;
  return exemptHosts
    .map((h) => String(h).trim().toLowerCase().replace(/^www\./, ''))
    .filter(Boolean)
    .some((h) => host === h || host.endsWith('.' + h));
}
