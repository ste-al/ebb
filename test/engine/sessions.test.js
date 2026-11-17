import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, connect, FakeBrowser } from '../fakes/harness.js';
import { MIN, HOUR } from '../../extension/lib/util.js';

/** Build the next browser session from the last one: same storage and Library, new tab ids. */
function nextSession(previous, { restore }) {
  const b = new FakeBrowser({ storage: previous.storageData, repo: previous.repo, firstId: 500, now: previous.time + 10 * HOUR });
  const windowId = b.openWindow();
  for (const { url, active = false } of restore) {
    // Chrome restores these before Ebb's service worker starts, so no events reach Ebb.
    const id = b.nextTabId++;
    b.tabs.set(id, {
      id, windowId, url, title: url, favIconUrl: '', active, pinned: false, audible: false, discarded: false,
      groupId: -1, status: 'complete', incognito: false, page: b.pageFor(url),
    });
    b.windows.get(windowId).order.push(id);
  }
  return b;
}

test('after a restart, restored tabs keep their tasks, stay unloaded, and missing ones go to the Library', async () => {
  const t1 = await setup({ settings: { laterMode: 'off' } });
  const s = await t1.open('https://www.google.com/search?q=kayak+trips', { transition: 'generated' });
  await t1.background(s, 'https://trips.example/a');
  await t1.background(s, 'https://trips.example/b');
  const x = await t1.open('https://github.com/ste-al/ebb', { transition: 'typed' });
  await t1.use(31); // both search results rest
  const searchHunt = t1.rec(s).huntId;
  const siteHunt = t1.rec(x).huntId;

  const b2 = nextSession(t1.browser, {
    restore: [
      { url: 'https://www.google.com/search?q=kayak+trips' },
      { url: 'https://trips.example/a' },
      { url: 'https://github.com/ste-al/ebb', active: true },
    ],
  });
  const t2 = await connect(b2);
  await t2.engine.dispatch('startup'); // runtime.onStartup
  await t2.settle();

  const [ns, na, nx] = b2.strip();
  assert.equal(t2.rec(ns).huntId, searchHunt, 'the search hunt survives the restart');
  assert.equal(t2.rec(na).huntId, searchHunt);
  assert.equal(t2.rec(nx).huntId, siteHunt);
  assert.equal(t2.tab(na).discarded, true, 'it was resting before the restart, so it stays unloaded');
  assert.equal(t2.tab(nx).discarded, false);
  assert.ok(t2.state.resume, 'a resume card is offered');
  assert.equal(b2.badge.text, '↺');

  b2.time += 3 * MIN;
  await t2.use(1);
  const [item] = await t2.items();
  assert.equal(item.url, 'https://trips.example/b', 'the tab that did not come back is in the Library');
  assert.equal(item.reason, 'session-end');
  const card = t2.state.resume.hunts.find((h) => h.huntId === searchHunt);
  assert.deepEqual([card.open, card.closed], [2, 1]);

  const res = await t2.act('focus-hunt', { huntId: siteHunt });
  assert.equal(res.count, 2, 'focusing on one task shelves the others');
  assert.equal(t2.state.resume, null);
  assert.equal(b2.badge.text, '');
});

test('the restart is noticed even if tab events arrive before onStartup', async () => {
  const t1 = await setup();
  const a = await t1.open('https://example.com/a', { transition: 'typed' });
  await t1.open('https://example.com/b', { transition: 'typed' });
  const hunt = t1.rec(a).huntId;

  const b2 = nextSession(t1.browser, { restore: [{ url: 'https://example.com/b', active: true }] });
  const t2 = await connect(b2);
  const late = b2.openTab('https://example.com/a', { active: false, transition: 'reload' });
  await t2.settle();
  assert.equal(t2.rec(late).huntId, hunt);
  assert.ok(t2.state.startup, 'adoption is under way without waiting for onStartup');
  await t2.engine.dispatch('startup');
  assert.equal(t2.rec(late).huntId, hunt, 'a late onStartup changes nothing');
});

test('reloading the extension is not mistaken for a browser restart', async () => {
  const t1 = await setup();
  const a = await t1.open('https://example.com/a', { transition: 'typed' });
  await t1.open('https://example.com/b', { transition: 'typed' });
  const hunt = t1.rec(a).huntId;
  t1.browser.sessionMarker = null; // chrome.storage.session is cleared on reload too

  const t2 = await connect(t1.browser);
  await t2.engine.dispatch('install', 'update');
  await t2.settle();
  assert.equal(t2.state.startup, null);
  assert.equal(t2.rec(a).huntId, hunt);
  assert.equal(t2.state.resume, null);
});

test('a closed window waits a few minutes in case you reopen it', async () => {
  const t = await setup();
  const w2 = t.browser.openWindow();
  await t.settle();
  const a = await t.open('https://example.com/a', { windowId: w2, transition: 'typed' });
  const b = await t.open('https://example.com/b', { windowId: w2, transition: 'typed' });
  const c = await t.open('https://example.com/c', { windowId: w2, transition: 'typed' });
  await t.act('shelve-tab', { tabId: a });
  await t.use(31); // b rests; c is the window's current tab
  assert.equal(t.tab(b).discarded, true);
  const huntA = t.rec(a).huntId;

  t.browser.closeWindow(w2);
  await t.settle();
  assert.equal(Object.keys(t.state.limbo).length, 3);

  const w3 = t.browser.openWindow(); // Ctrl+Shift+T brings the window back
  await t.settle();
  const again = await t.open('https://example.com/a', { windowId: w3, transition: 'reload' });
  assert.equal(t.rec(again).huntId, huntA, 'adopted: same record as before');

  t.browser.time += 6 * MIN;
  await t.use(1);
  const items = await t.items();
  assert.deepEqual(items.map((i) => i.url), ['https://example.com/b'], 'only the tab Ebb had tidied is kept');
  assert.equal(items[0].reason, 'window-closed');
  assert.deepEqual(t.state.limbo, {});
});

test('state survives the service worker being stopped and started', async () => {
  const t1 = await setup();
  const a = await t1.open('https://example.com/a', { transition: 'typed' });
  await t1.open('https://example.com/b', { transition: 'typed' });
  await t1.use(5);
  const t2 = await connect(t1.browser); // same browser session, new worker
  await t2.use(26);
  assert.equal(t2.tab(a).discarded, true, 'the active clock carried over');
  assert.equal(t2.state.clock.activeMs, 31 * MIN);
});
