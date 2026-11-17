// Renders the real side panel with example data and saves screenshots
// to docs/screenshots/. Usage: node scripts/screenshots.js  (CHROME_PATH as for the e2e test)
//
// The panel's messages to the service worker are answered with the example view model
// below, so the pictures don't depend on whatever tabs happen to be open.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';

/** Runs inside the panel page before its own script: answers its messages with example data. */
export function installExample() {
  const MIN = 60 * 1000;
  const now = Date.now();
  let n = 0;
  const tab = (url, title, extra = {}) => ({
    tabId: ++n, windowId: 1, index: n, title, url, host: new URL(url).hostname.replace(/^www\./, ''),
    stage: 'live', active: false, pinned: false, grouped: false, protected: null, keep: null, keepUntil: 0, visits: 1, next: null, ...extra,
  });
  const next = (stage, minutes) => ({ stage, inMs: minutes * MIN });
  const shoes = [
    tab('https://www.google.com/search?q=trail+running+shoes+wide+feet', 'trail running shoes wide feet - Google Search', { next: next('resting', 4) }),
    tab('https://www.runnersworld.com/gear/a2/best-trail-running-shoes/', 'The Best Trail Running Shoes of 2026, Tested', { active: true }),
    tab('https://www.rei.com/product/240012/altra-lone-peak-9', 'Altra Lone Peak 9 Trail-Running Shoes', { next: next('resting', 22) }),
    tab('https://www.reddit.com/r/trailrunning/comments/1x/wide_toe_box/', 'Wide toe box recommendations? : r/trailrunning', { stage: 'resting', next: next('shelved', 95) }),
    tab('https://www.topoathletic.com/mtn-racer-4', 'MTN Racer 4 | Topo Athletic', { stage: 'shelved', next: next('archived', 610) }),
    tab('https://www.brooksrunning.com/en_us/cascadia-18', 'Cascadia 18 Trail Running Shoes', { stage: 'shelved', next: next('archived', 540) }),
  ];
  const code = [
    tab('https://github.com/ste-al/ebb/pull/12', 'Lifecycle: measure idle time from when you leave a tab #12', { visits: 4, next: next('resting', 310) }),
    tab('https://developer.chrome.com/docs/extensions/reference/api/tabGroups', 'chrome.tabGroups | API | Chrome for Developers', { stage: 'resting', next: next('shelved', 260) }),
    tab('https://github.com/ste-al/ebb/issues', 'Issues · ste-al/ebb', { protected: 'kept for now', keepUntil: now + 5 * 24 * 60 * MIN }),
  ];
  const trip = [
    tab('https://www.google.com/search?q=lisbon+weekend+itinerary', 'lisbon weekend itinerary - Google Search', { stage: 'resting', next: next('shelved', 40) }),
    tab('https://www.visitlisboa.com/en/p/48-hours-in-lisbon', '48 hours in Lisbon | Visit Lisboa', { stage: 'resting', next: next('shelved', 70) }),
    tab('https://en.wikipedia.org/wiki/Bel%C3%A9m_Tower', 'Belém Tower - Wikipedia', { stage: 'shelved', next: next('archived', 1900) }),
    tab('https://www.timeout.com/lisbon/restaurants/best-restaurants-in-lisbon', 'The 30 best restaurants in Lisbon', { stage: 'shelved', next: next('archived', 880) }),
  ];
  const loose = [
    tab('https://www.bbc.com/news/articles/c0tide', 'Spring tides: why this weekend’s will be the highest in years', { protected: 'playing' }),
  ];
  const steady = [
    tab('https://mail.google.com/mail/u/0/#inbox', 'Inbox (3) - mail', { pinned: true, protected: 'pinned' }),
    tab('https://calendar.google.com/calendar/u/0/r/week', 'Google Calendar - Week of November 16', { protected: 'app' }),
  ];
  const counts = (tabs) => ({
    live: tabs.filter((t) => t.stage === 'live').length,
    resting: tabs.filter((t) => t.stage === 'resting').length,
    shelved: tabs.filter((t) => t.stage === 'shelved').length,
  });
  const hunt = (id, name, origin, tabs, ago) => ({ id, name, origin, tabs, counts: counts(tabs), lastActiveAt: now - ago * MIN });
  const all = [...shoes, ...code, ...trip, ...loose];
  const later = [
    { id: 'l1', url: 'https://www.outsideonline.com/outdoor-adventure/hiking/fastpacking-guide/', title: 'The beginner’s guide to fastpacking', savedAt: now - 50 * MIN, source: { title: 'Hacker News' } },
    { id: 'l2', url: 'https://www.ultrarunning.com/features/the-art-of-the-taper/', title: 'The art of the taper', savedAt: now - 52 * MIN, source: { title: 'Hacker News' } },
    { id: 'l3', url: 'https://ourworldindata.org/tides-and-energy', title: 'Tidal energy: how much could it supply?', savedAt: now - 26 * 60 * MIN, source: { title: 'Spring tides: why this weekend’s…' } },
  ];
  const library = [
    { id: 'a1', url: 'https://www.ikea.com/us/en/p/trotten-desk', title: 'TROTTEN Desk sit/stand, white', archivedAt: now - 4 * MIN, reason: 'mission', huntName: 'standing desk under 300', excerpt: 'Switch between sitting and standing with the crank. The height adjusts from 28 to 47 inches…' },
    { id: 'a2', url: 'https://www.nytimes.com/wirecutter/reviews/best-standing-desks/', title: 'The Best Standing Desks', archivedAt: now - 4 * MIN, reason: 'mission', huntName: 'standing desk under 300', excerpt: 'After testing 21 models over six years, we think the Uplift V2 is the best standing desk for most people…' },
    { id: 'a3', url: 'https://www.seriouseats.com/sourdough-starter', title: 'How to Make a Sourdough Starter', archivedAt: now - 20 * 60 * MIN, reason: 'idle', huntName: 'sourdough starter', excerpt: 'A starter is just flour and water, left to ferment until wild yeast and bacteria take hold. Feed it twice a day…' },
    { id: 'a4', url: 'https://www.mbari.org/tide-pools/', title: 'Tide pools of Monterey Bay', archivedAt: now - 2 * 24 * 60 * MIN, reason: 'session-end', huntName: 'tide pools near me', excerpt: 'Low tide exposes a whole world: anemones, sea stars and hermit crabs wait for the water to return…' },
    { id: 'a5', url: 'https://news.ycombinator.com/item?id=4242', title: 'Show HN: A tab manager that forgets for you', archivedAt: now - 3 * 24 * 60 * MIN, reason: 'later-expired', huntName: 'Later', excerpt: '' },
  ];
  const vm = {
    now,
    activeMinutes: 2715,
    settings: { paused: false, pace: 'balanced', budget: 15, useShelf: true, laterMode: 'guard', laterAllow: 4, laterWindowMin: 5, laterExpireDays: 14, mission: true, respectGroups: true, captureText: true, exemptHosts: [] },
    totals: { live: all.filter((t) => t.stage === 'live').length + steady.length, resting: all.filter((t) => t.stage === 'resting').length, shelved: all.filter((t) => t.stage === 'shelved').length },
    windows: [
      {
        windowId: 1,
        current: true,
        steady,
        hunts: [
          hunt('h1', 'trail running shoes wide feet', 'search', shoes, 0),
          hunt('h2', 'github.com', 'site', code, 12),
          hunt(null, 'Loose tabs', 'loose', loose, 30),
          hunt('h3', 'lisbon weekend itinerary', 'search', trip, 200),
        ],
      },
    ],
    later,
    libraryCount: 214,
    ledger: {
      week: { rested: 131, shelved: 58, archived: 37, tucked: 11, queued: 14, restored: 4, openedLater: 6, tidied: 86, rate: 4 / 86 },
      sentence: 'Ebb tidied 86 tabs and you brought back 4 (4.7%). Nothing was deleted.',
      hostMult: { 'docs.google.com': 3, 'github.com': 2 },
    },
    resume: null,
    lastBatch: { id: 'b1', kind: 'tuck', at: now - 4 * MIN, count: 5, label: 'Tucked away 5 tabs from “standing desk under 300”' },
  };
  if (location.hash === '#resume') {
    vm.resume = {
      at: now,
      batchId: 'b0',
      hunts: [
        { huntId: 'h1', name: 'trail running shoes wide feet', open: 6, closed: 0 },
        { huntId: 'h2', name: 'github.com', open: 3, closed: 1 },
        { huntId: 'h3', name: 'lisbon weekend itinerary', open: 4, closed: 2 },
      ],
    };
    vm.lastBatch = null;
  }

  const answer = async (msg) => {
    switch (msg?.type) {
      case 'panel:state':
        return structuredClone(vm);
      case 'panel:library': {
        const terms = String(msg.q || '').toLowerCase().split(/\s+/).filter(Boolean);
        const items = library.filter((i) => terms.every((t) => `${i.title} ${i.url} ${i.excerpt}`.toLowerCase().includes(t)));
        return { total: items.length, items };
      }
      case 'panel:settings':
        return vm.settings;
      default:
        return { ok: true };
    }
  };
  chrome.runtime.sendMessage = answer;
  // Ignore change broadcasts from the real service worker, so the picture holds still.
  chrome.runtime.onMessage.addListener = () => {};

  // Letter icons stand in for site favicons, which this fresh browser profile has never seen.
  const colors = ['#0f766e', '#7c3aed', '#c2410c', '#0369a1', '#be123c', '#4d7c0f', '#a16207', '#334155'];
  const letterIcon = (host) => {
    const sum = [...host].reduce((a, c) => a + c.charCodeAt(0), 0);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3.5" fill="${colors[sum % colors.length]}"/><text x="8" y="12" font-family="Arial,sans-serif" font-size="10" font-weight="700" fill="#fff" text-anchor="middle">${host[0].toUpperCase()}</text></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  };
  new MutationObserver(() => {
    for (const img of document.querySelectorAll('img.favicon:not([data-done])')) {
      const page = new URL(img.src).searchParams.get('pageUrl');
      img.dataset.done = '1';
      img.src = letterIcon(new URL(page).hostname.replace(/^www\./, ''));
    }
  }).observe(document, { childList: true, subtree: true });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    pipe: true,
    protocolTimeout: 30000,
    enableExtensions: [path.join(ROOT, 'extension')],
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ebb-shots-')),
    args: ['--no-sandbox', '--no-first-run', '--hide-scrollbars'],
  });
  try {
    const target = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'));
    const id = new URL(target.url()).host;
    const shoot = async (name, { width, height, hash = '', view, dark = false, before }) => {
      const page = await browser.newPage();
      page.on('pageerror', (err) => console.error(`${name}: ${err.message}`));
      await page.bringToFront(); // background tabs don't render, so clicks would wait forever
      await page.setViewport({ width, height, deviceScaleFactor: 2 });
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }]);
      if (name.startsWith('panel')) await page.evaluateOnNewDocument(installExample);
      const url = name.startsWith('panel') ? `chrome-extension://${id}/sidepanel/index.html${hash}` : `chrome-extension://${id}/welcome/index.html`;
      await page.goto(url, { waitUntil: 'load' });
      if (view) {
        await page.waitForSelector('.hunt', { timeout: 10000 });
        await page.$eval(`[data-view="${view}"]`, (el) => el.click());
      }
      if (name.startsWith('panel')) {
        // Headless Chrome reports no hover-capable pointer, which shows every row's actions.
        // Show the desktop look instead: actions only on the row under the mouse.
        await page.addStyleTag({
          content: '.row .actions, .hunt-head .actions { opacity: 0 !important } .row.demo-hover { background: var(--hover) } .row.demo-hover .actions { opacity: 1 !important }',
        });
        await page.evaluate(() => document.querySelectorAll('#view-now .row')[2]?.classList.add('demo-hover'));
      }
      if (before) await before(page);
      await new Promise((r) => setTimeout(r, 400));
      await page.screenshot({ path: path.join(OUT, `${name}.png`) });
      await page.close();
      console.log('wrote', path.relative(ROOT, path.join(OUT, `${name}.png`)));
    };
    const openShelf = (page) => page.evaluate(() => document.querySelectorAll('.shelved-rows').forEach((d) => (d.open = true)));
    await shoot('panel-now', { width: 380, height: 860, view: 'now', before: openShelf });
    await shoot('panel-now-dark', { width: 380, height: 860, view: 'now', dark: true, before: openShelf });
    await shoot('panel-resume', { width: 380, height: 520, hash: '#resume', view: 'now' });
    await shoot('panel-later', { width: 380, height: 420, view: 'later' });
    await shoot('panel-library', { width: 380, height: 640, view: 'library' });
    await shoot('panel-ledger', { width: 380, height: 560, view: 'ledger' });
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
