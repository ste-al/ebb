import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, connect, nextSession } from '../fakes/harness.js';
import { MIN, HOUR } from '../../extension/lib/util.js';

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

test('a second browser launch during adoption matches both generations of tabs to their new IDs', async () => {
  const t1 = await setup();
  const urls = ['first', 'second', 'missing'].map((name) => `https://example.com/${name}`);
  const hunts = [];
  for (const url of urls) hunts.push(t1.rec(await t1.open(url)).huntId);
  const b2 = nextSession(t1.browser, { restore: [{ url: urls[0], active: true }] });
  const t2 = await connect(b2);
  await t2.engine.dispatch('startup');
  const b3 = nextSession(b2, {
    firstId: 900, after: MIN, restore: [{ url: urls[0], active: true }, { url: urls[1] }],
  });
  const t3 = await connect(b3);
  await t3.engine.dispatch('startup');
  await t3.settle();
  assert.deepEqual(b3.strip().map((id) => t3.rec(id)?.huntId), hunts.slice(0, 2));
  assert.equal(t3.rec(500), undefined);
  await t3.use(3);
  assert.deepEqual((await t3.items()).map((i) => i.url), [urls[2]]);
  await t3.engine.dispatch('startup');
  assert.equal(t3.state.startup, null, 'a late startup event from this session does not reopen recovery');
});

test('reused tab IDs leave missing pages available to the browser startup event', async () => {
  const t1 = await setup();
  const urls = ['kept', 'reused', 'missing'].map((name) => `https://example.com/${name}`);
  for (const url of urls) await t1.open(url);
  const browser = nextSession(t1.browser, { firstId: 1, restore: [{ url: urls[0], active: true }, { url: urls[1] }] });
  const t2 = await connect(browser);
  await t2.engine.dispatch('startup');
  await t2.use(3);
  assert.deepEqual((await t2.items()).map((item) => item.url), [urls[2]]);
});

test('a restored user group named Shelf stays independent of Ebb’s own Shelf', async () => {
  const t1 = await setup();
  const shelved = await t1.open('https://example.com/shelved');
  await t1.open('https://example.com/mine');
  await t1.act('shelve-tab', { tabId: shelved });
  const b2 = nextSession(t1.browser, { restore: [
    { url: 'https://example.com/shelved' }, { url: 'https://example.com/mine', active: true },
  ] });
  const [own, mine] = b2.strip().map((id) => {
    const groupId = b2.groupTabs({ tabIds: [id] });
    Object.assign(b2.groups.get(groupId), { title: 'Shelf · 1', color: 'grey' });
    return groupId;
  });
  const t2 = await connect(b2);
  await t2.engine.dispatch('startup');
  await t2.settle();
  assert.equal(t2.state.shelf[b2.focusedWindow], own);
  assert.equal(t2.tab(b2.strip()[1]).groupId, mine);
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

test('recovery retries a failed Library write without re-archiving a page already brought back', async () => {
  const t1 = await setup();
  const urls = ['first', 'second', 'open'].map((name) => `https://example.com/${name}`);
  for (const url of urls) await t1.open(url);
  const browser = nextSession(t1.browser, { restore: [{ url: urls[2], active: true }] });
  const t2 = await connect(browser);
  await t2.engine.dispatch('startup');
  browser.time += 3 * MIN;
  const put = browser.repo.put;
  browser.repo.put = async (store, item, ...args) => {
    if (store === 'library' && item.url === urls[1]) throw new Error('write interrupted');
    await put(store, item, ...args);
  };
  await assert.rejects(t2.engine.dispatch('tick'), /write interrupted/);
  browser.repo.put = put;
  const [first] = await t2.items();
  assert.equal(first.url, urls[0]);
  await t2.act('restore-item', { id: first.id });
  await t2.use(1);
  assert.equal(t2.state.startup, null);
  assert.deepEqual((await t2.items()).map((item) => item.url), [urls[1]]);
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
