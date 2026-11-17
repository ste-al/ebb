// End-to-end smoke test: loads the real extension into Chrome for Testing and drives it
// against a small local site. Run with `npm run test:e2e` (set CHROME_PATH if Chrome for
// Testing is not at /usr/bin/google-chrome).
//
// The active-time clock is moved forward by hand (and back afterwards) instead of waiting
// hours, and lifecycle passes are run directly instead of waiting for you to step away.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXTENSION = path.join(ROOT, 'extension');
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const MIN = 60 * 1000;

let server;
let base;
let port;
/** Same local server, separate site (so a separate hunt): http://shop.test:<port>/ */
const site = (name) => `http://${name}.test:${port}`;
let browser;
let worker;
let extensionId;
const workerErrors = [];

// ---------------------------------------------------------------- a tiny test site

const html = (title, body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>` +
  `<meta name="description" content="${title}: a page for testing Ebb."></head>` +
  `<body style="font: 16px/1.6 sans-serif; max-width: 40em; margin: 2em auto">${body}</body></html>`;

const article = (n) =>
  html(
    `Article ${n}`,
    `<main><article><h1>Article ${n}</h1>` +
      Array.from({ length: 60 }, (_, i) => `<p>Paragraph ${i + 1} of article ${n}. The tide comes in and the tide goes out, twice a day, pulled by the moon.</p>`).join('') +
      `<p><a id="next" href="/article/${n + 1}">Next article</a></p></article></main>`,
  );

function startServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const send = (body, status = 200) => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
        res.end(body);
      };
      if (url.pathname === '/links') {
        const links = Array.from({ length: 9 }, (_, i) => `<li><a id="l${i + 1}" href="/article/${i + 1}">Article number ${i + 1} about tides</a></li>`);
        send(html('Reading list', `<h1>Reading list</h1><ul>${links.join('')}</ul><p><a id="buy" href="/order/confirmation">Buy</a></p>`));
      } else if (url.pathname.startsWith('/article/')) {
        send(article(Number(url.pathname.split('/')[2]) || 0));
      } else if (url.pathname === '/order/confirmation') {
        send(html('Order confirmed', '<h1>Thank you for your order!</h1><p>Order number: 12345</p>'));
      } else {
        send(html('Not found', 'Not found'), 404);
      }
    });
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      base = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

// ---------------------------------------------------------------- helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 10000, interval = 100, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}

/** Run a function inside Ebb's service worker. */
const sw = (fn, ...args) => worker.evaluate(fn, ...args);

const settings = (patch) => sw((p) => globalThis.ebb.engine.dispatch('onMessage', { type: 'panel:settings', patch: p }), patch);
const panel = (action, args = {}) => sw((a, x) => globalThis.ebb.engine.dispatch('onMessage', { type: 'panel:do', action: a, ...x }), action, args);
const tabsFor = (url) => sw((u) => chrome.tabs.query({ url: u }), url);
const tabById = (id) => sw((i) => chrome.tabs.get(i).catch(() => null), id);
const repo = (store) => sw((s) => globalThis.ebb.engine.p.repo.getAll(s), store);

/** Pretend `minutes` of active browsing passed, run one lifecycle pass, then wind the clock back. */
function lifecycleAfter(minutes, { boundary }) {
  return sw(
    async (ms, atBoundary) => {
      const e = globalThis.ebb.engine;
      const shift = (d) =>
        e.enqueue(async () => {
          await e.load();
          e.state.clock.activeMs += d;
          e.touch();
        });
      await shift(ms);
      await e.dispatch('lifecycle', { boundary: atBoundary });
      if (atBoundary) await e.dispatch('maintainShelves');
      await shift(-ms);
    },
    minutes * MIN,
    boundary,
  );
}

async function openPage(url) {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'load' });
  await page.bringToFront();
  return page;
}

async function findPage(url) {
  return waitFor(async () => (await browser.pages()).find((p) => p.url() === url), { what: `a page at ${url}` });
}

const hasToast = (page) => page.evaluate(() => Boolean(document.querySelector('ebb-toast')));

/** Click a button inside Ebb's toast. The toast lives in a closed shadow root, so find it through the DevTools DOM. */
async function clickToastButton(page, label) {
  const client = await page.createCDPSession();
  try {
    const node = await waitFor(
      async () => {
        const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
        const stack = [root];
        while (stack.length) {
          const n = stack.pop();
          if (n.nodeName === 'BUTTON') {
            const text = (n.children || []).filter((c) => c.nodeType === 3).map((c) => c.nodeValue).join('').trim();
            if (text === label) return n;
          }
          stack.push(...(n.children || []), ...(n.shadowRoots || []));
        }
        return null;
      },
      { what: `the toast button "${label}"` },
    );
    await sleep(250); // let the toast finish sliding in
    const { model } = await client.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId });
    const [x1, y1, , , x3, y3] = model.content;
    await page.mouse.click((x1 + x3) / 2, (y1 + y3) / 2);
  } finally {
    await client.detach();
  }
}

// ---------------------------------------------------------------- setup

before(async () => {
  assert.ok(fs.existsSync(CHROME), `Chrome for Testing not found at ${CHROME}; set CHROME_PATH`);
  await startServer();
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    pipe: true,
    enableExtensions: [EXTENSION],
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ebb-e2e-')),
    args: [
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,900',
      '--host-resolver-rules=MAP *.test 127.0.0.1',
    ],
  });
  const target = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 15000 });
  extensionId = new URL(target.url()).host;
  worker = await target.worker();
  worker.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warn') workerErrors.push(msg.text());
  });
  await waitFor(() => sw(() => Boolean(globalThis.ebb?.engine?.state)), { what: 'the engine to install' });
});

after(async () => {
  await browser?.close();
  server?.close();
});

// ---------------------------------------------------------------- the tour

test('Ebb installs: the service worker starts and the welcome page opens', async () => {
  const welcome = await findPage(`chrome-extension://${extensionId}/welcome/index.html`);
  assert.equal(await welcome.title(), 'Welcome to Ebb');
  const s = await settings({});
  assert.equal(s.pace, 'balanced');
  const menus = await sw(() => chrome.contextMenus !== undefined);
  assert.ok(menus);
});

test('leaving a page captures your place; resting, the Shelf and coming back work in Chrome', async () => {
  const p1 = await openPage(`${base}/article/1`);
  await p1.evaluate(() => window.scrollTo(0, 1500));
  await sleep(150);
  await openPage(`${base}/article/2`); // switching tabs captures article 1
  const [t1] = await tabsFor(`${base}/article/1`);

  const rec = await waitFor(() => sw((id) => globalThis.ebb.engine.state.tabs[id]?.freeze?.scrollY > 1000 && globalThis.ebb.engine.state.tabs[id], t1.id), {
    what: 'the scroll position to be captured',
  });
  assert.match(rec.excerpt, /The tide comes in/);
  assert.equal(rec.description, 'Article 1: a page for testing Ebb.');

  await lifecycleAfter(31, { boundary: false });
  const rested = await tabById(t1.id);
  assert.equal(rested.discarded, true, 'unloaded after 30 active minutes');

  await lifecycleAfter(200, { boundary: true });
  const shelved = await tabById(t1.id);
  assert.notEqual(shelved.groupId, -1, 'moved to the Shelf at a boundary');
  const group = await sw((g) => chrome.tabGroups.get(g), shelved.groupId);
  assert.equal(group.title, 'Shelf · 1');
  assert.equal(group.collapsed, true);
  const all = await sw(() => chrome.tabs.query({ currentWindow: true }));
  assert.equal(all.at(-1).id, t1.id, 'the Shelf is at the end of the tab bar');

  await sw((id) => chrome.tabs.update(id, { active: true }), t1.id); // click it on the Shelf
  await waitFor(async () => (await tabById(t1.id)).groupId === -1, { what: 'the tab to leave the Shelf' });
  const page = await findPage(`${base}/article/1`);
  await waitFor(() => page.evaluate(() => document.readyState === 'complete' && window.scrollY > 1000), { what: 'the scroll position to come back' });
  const events = await repo('ledger');
  assert.deepEqual([...new Set(events.map((e) => e.type))].sort(), ['rest', 'restore', 'shelve']);
});

test('a tab closed into the Library comes back with its history', async () => {
  const p = await openPage(`${base}/article/5`);
  await p.click('#next'); // article 6: two entries of history
  await p.waitForFunction(() => location.pathname === '/article/6');
  const historyLength = await p.evaluate(() => history.length);
  await openPage(`${base}/links`);
  const [tab] = await tabsFor(`${base}/article/6`);

  assert.deepEqual(await panel('archive-tab', { tabId: tab.id }), { ok: true });
  await waitFor(async () => (await tabsFor(`${base}/article/6`)).length === 0, { what: 'the tab to close' });
  const [item] = (await repo('library')).filter((i) => i.url === `${base}/article/6`);
  assert.equal(item.title, 'Article 6');
  assert.match(item.excerpt, /article 6/);

  assert.deepEqual(await panel('restore-item', { id: item.id }), { ok: true });
  const back = await findPage(`${base}/article/6`);
  await waitFor(async () => (await back.evaluate(() => history.length)) === historyLength, { what: 'the history to come back too' });
  assert.equal((await repo('library')).filter((i) => i.url === `${base}/article/6`).length, 0);
});

test('the Later lane catches background tabs and says so on the page', async () => {
  await settings({ laterMode: 'always' });
  const src = await openPage(`${base}/links`);
  await src.click('#l3', { button: 'middle' });
  const [item] = await waitFor(async () => {
    const later = await repo('later');
    return later.length === 1 && later;
  }, { what: 'a Later item' });
  assert.equal(item.url, `${base}/article/3`);
  assert.equal(item.title, 'Article number 3 about tides', 'named after the link text');
  await waitFor(async () => (await tabsFor(`${base}/article/3`)).length === 0, { what: 'the background tab to close' });
  await waitFor(() => hasToast(src), { what: 'the toast' });
  await waitFor(async () => (await sw(() => chrome.action.getBadgeText({}))) === '1', { what: 'the toolbar badge to count it' });

  await clickToastButton(src, 'Open now');
  await waitFor(async () => (await tabsFor(`${base}/article/3`)).length === 1, { what: 'the link to open' });
  assert.equal((await repo('later')).length, 0);
  await settings({ laterMode: 'guard' });
});

test('mission accomplished: a confirmation page offers to tuck the task away, with Undo', async () => {
  const shopUrl = site('shop');
  const shop = await openPage(`${shopUrl}/links`);
  const isTaskTab = (t) => /\/article\/[789]$/.test(t.url);
  for (const id of ['#l7', '#l8', '#l9']) await shop.click(id, { button: 'middle' });
  await waitFor(async () => (await tabsFor(`${shopUrl}/article/*`)).filter(isTaskTab).length === 3, { what: 'three background tabs' });
  await shop.click('#buy');
  await shop.waitForFunction(() => location.pathname === '/order/confirmation');
  await waitFor(() => hasToast(shop), { timeout: 15000, what: 'the mission toast' });

  await clickToastButton(shop, 'Tuck away');
  await waitFor(async () => (await tabsFor(`${shopUrl}/article/*`)).length === 0, { what: 'the task’s tabs to be tucked away' });
  const items = await repo('library');
  assert.equal(items.filter((i) => i.reason === 'mission').length, 3);
  assert.equal(items.filter((i) => i.reason === 'receipt').length, 1);
  assert.equal((await tabsFor(`${shopUrl}/order/confirmation`)).length, 1, 'the confirmation page stays open');
  assert.equal((await tabsFor(`${base}/*`)).length > 0, true, 'other sites are untouched');

  await clickToastButton(shop, 'Undo');
  const back = await waitFor(async () => {
    const tabs = (await tabsFor(`${shopUrl}/article/*`)).filter(isTaskTab);
    return tabs.length === 3 && tabs;
  }, { what: 'the tabs to come back' });
  await waitFor(async () => (await Promise.all(back.map((t) => tabById(t.id)))).every((t) => t.discarded), {
    what: 'the restored tabs to stay unloaded',
  });
  assert.equal((await repo('library')).filter((i) => i.reason === 'mission' || i.reason === 'receipt').length, 0);
});

test('the side panel renders the current state', async () => {
  await openPage(`${site('notes')}/article/42`);
  await openPage(`${base}/links`);
  const [tab] = await tabsFor(`${site('notes')}/article/42`);
  await panel('archive-tab', { tabId: tab.id });

  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => msg.type() === 'error' && errors.push(msg.text()));
  await page.setViewport({ width: 400, height: 900 });
  await page.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
  await page.waitForSelector('.hunt');
  const summary = await page.$eval('#summary', (el) => el.textContent);
  assert.match(summary, /\d+ open/);
  assert.match(summary, /in the Library/);
  const names = await page.$$eval('.hunt-title strong', (els) => els.map((el) => el.textContent));
  assert.ok(names.includes('127.0.0.1'), `hunts shown: ${names.join(', ')}`);

  await page.click('[data-view="library"]');
  await page.waitForSelector('#library-list .row');
  await page.type('#library-q', 'notes.test');
  await waitFor(() => page.$$eval('#library-list .row-title', (rows) => rows.length === 1 && rows[0].textContent === 'Article 42'), {
    what: 'the Library search',
  });

  await page.click('[data-view="ledger"]');
  const sentence = await page.$eval('.ledger-sentence', (el) => el.textContent);
  assert.match(sentence, /Ebb tidied \d+ tabs? and you brought back \d+/);

  await page.click('[data-view="settings"]');
  await page.click('input[name="s-pace"][value="brisk"]');
  await waitFor(async () => (await settings({})).pace === 'brisk', { what: 'the setting to save' });
  assert.deepEqual(errors, []);
});

test('the service worker logged no errors', () => {
  assert.deepEqual(workerErrors, []);
});
