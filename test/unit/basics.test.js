import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostOf, isWebUrl, normalizeUrl, prettyUrl, formatDuration, excerpt, MIN, HOUR, DAY } from '../../extension/lib/util.js';
import { parseSearch, tokens, similarity } from '../../extension/lib/search.js';
import { classify, isExempt } from '../../extension/lib/classify.js';
import { withDefaults, DEFAULT_SETTINGS } from '../../extension/lib/settings.js';

test('util: hosts, web URLs and normalization', () => {
  assert.equal(hostOf('https://www.Example.com/a?b=1'), 'example.com');
  assert.equal(hostOf('not a url'), '');
  assert.equal(isWebUrl('https://x.y'), true);
  assert.equal(isWebUrl('chrome://newtab/'), false);
  assert.equal(isWebUrl('javascript:alert(1)'), false);
  assert.equal(
    normalizeUrl('https://example.com/p?id=7&utm_source=x&fbclid=abc&gclid=1#section'),
    'https://example.com/p?id=7',
  );
  assert.equal(normalizeUrl('https://example.com/p?ref=keep'), 'https://example.com/p?ref=keep', 'ordinary parameters stay');
  assert.equal(normalizeUrl('https://app.example/#/inbox'), 'https://app.example/#/inbox', 'app routes are different pages');
  assert.equal(normalizeUrl('https://app.example/#!/item/4'), 'https://app.example/#!/item/4');
  assert.equal(normalizeUrl('https://youtu.be/x?si=share123'), 'https://youtu.be/x');
  assert.equal(prettyUrl('https://www.example.com/docs/guide/'), 'example.com/docs/guide');
  assert.match(prettyUrl(`https://example.com/${'a'.repeat(80)}`), /…$/);
});

test('util: durations and excerpts', () => {
  assert.equal(formatDuration(30 * 1000), '30s');
  assert.equal(formatDuration(12 * MIN), '12m');
  assert.equal(formatDuration(3 * HOUR), '3h');
  assert.equal(formatDuration(2 * DAY), '2d');
  assert.equal(excerpt('  a   b  '), 'a b');
  const long = excerpt('word '.repeat(300), 100);
  assert.ok(long.length <= 101 && long.endsWith('…') && !long.includes('wor…'));
});

test('search: recognizes results pages across engines and countries', () => {
  const cases = [
    ['https://www.google.com/search?q=trail+running+shoes&sca_esv=1', 'Google', 'trail running shoes'],
    ['https://www.google.cz/search?q=pra%C5%BEsk%C3%A9+jaro', 'Google', 'pražské jaro'],
    ['https://www.google.co.uk/search?q=tide+times', 'Google', 'tide times'],
    ['https://www.bing.com/search?q=desk+lamp', 'Bing', 'desk lamp'],
    ['https://duckduckgo.com/?q=sourdough&ia=web', 'DuckDuckGo', 'sourdough'],
    ['https://search.seznam.cz/?q=po%C4%8Das%C3%AD', 'Seznam', 'počasí'],
    ['https://www.youtube.com/results?search_query=knot+tying', 'YouTube', 'knot tying'],
    ['https://www.amazon.de/s?k=standing+desk', 'Amazon', 'standing desk'],
    ['https://github.com/search?q=tab+manager&type=repositories', 'GitHub', 'tab manager'],
    ['https://scholar.google.com/scholar?q=tidal+energy&hl=en', 'Google Scholar', 'tidal energy'],
  ];
  for (const [url, engine, query] of cases) assert.deepEqual(parseSearch(url), { engine, query }, url);
  assert.equal(parseSearch('https://www.google.com/maps/place/x'), null);
  assert.equal(parseSearch('https://www.google.com/search?q='), null);
  assert.equal(parseSearch('https://duckduckgo.com/about'), null);
});

test('search: query similarity ignores stopwords, case and accents', () => {
  assert.deepEqual(tokens('The Best Café for Pražské jaro'), ['cafe', 'prazske', 'jaro']);
  assert.equal(similarity('trail running shoes', 'Trail Running Shoes'), 1);
  assert.ok(similarity('trail running shoes', 'trail running shoes wide feet') >= 0.5);
  assert.equal(similarity('trail running shoes', 'sourdough starter'), 0);
});

test('classify: lifetimes follow what a page usually is', () => {
  const cases = {
    'https://mail.google.com/mail/u/0/': 'app',
    'https://claude.ai/new': 'app',
    'https://www.google.com/search?q=x': 'search',
    'https://www.amazon.com/dp/B0': 'shopping',
    'https://www.youtube.com/watch?v=1': 'video',
    'https://docs.google.com/document/d/1': 'doc',
    'https://team.atlassian.net/wiki': 'doc',
    'https://developer.mozilla.org/en-US/docs/Web': 'reference',
    'https://cs.wikipedia.org/wiki/Praha': 'reference',
    'https://docs.python.org/3/': 'reference',
    'https://www.bbc.co.uk/news/1': 'news',
    'https://www.idnes.cz/zpravy': 'news',
    'https://old.reddit.com/r/x': 'social',
    'https://www.alza.cz/notebooky': 'shopping',
    'https://example.com/': 'other',
    'chrome://settings/': 'internal',
  };
  for (const [url, kind] of Object.entries(cases)) assert.equal(classify(url), kind, url);
});

test('classify: exempt sites include their subdomains only', () => {
  assert.equal(isExempt('https://wiki.example.org/x', ['example.org']), true);
  assert.equal(isExempt('https://example.org/x', ['www.example.org']), true);
  assert.equal(isExempt('https://notexample.org/x', ['example.org']), false);
  assert.equal(isExempt('https://example.org/x', []), false);
});

test('settings: defaults, clamping and unknown keys', () => {
  assert.deepEqual(withDefaults(undefined), { ...DEFAULT_SETTINGS, exemptHosts: [] });
  const s = withDefaults({ pace: 'brisk', budget: '9000', laterAllow: 'x', laterMode: 'nope', paused: 1, extra: true });
  assert.equal(s.pace, 'brisk');
  assert.equal(s.budget, 500);
  assert.equal(s.laterAllow, DEFAULT_SETTINGS.laterAllow);
  assert.equal(s.laterMode, 'guard');
  assert.equal(s.paused, true);
  assert.equal('extra' in s, false);
});
