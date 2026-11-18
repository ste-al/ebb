// Scenarios for the 0.2 revision: robustness fixes and the new features.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, connect, nextSession } from '../fakes/harness.js';
import { MIN } from '../../extension/lib/util.js';

// ---------------------------------------------------------------- fixes

test('unsaved typing survives a same-document URL change, and a new page clears it', async () => {
  const t = await setup();
  const form = await t.open('https://example.com/compose', { transition: 'typed' });
  await t.open('https://example.com/other', { transition: 'typed' });
  await t.message({ type: 'ebb:dirty', dirty: true }, { tab: t.tab(form) });

  // The page changes its address with history.pushState: same document, typing still there.
  const url = 'https://example.com/compose#draft-2';
  t.browser.tabs.get(form).url = url;
  t.browser.api.tabs.onUpdated.emit(form, { url }, t.tab(form));
  t.browser.api.webNavigation.onHistoryStateUpdated.emit({ tabId: form, frameId: 0, url, transitionType: 'link' });
  await t.settle();
  assert.equal(t.rec(form).dirty, true);
  await t.skip(40);
  assert.equal(t.tab(form).discarded, false, 'still protected');

  await t.navigate(form, 'https://example.com/sent', { transition: 'form_submit' });
  assert.equal(t.rec(form).dirty, false, 'a new document starts clean');
});

test('two restarts in quick succession keep the first one’s missing tabs', async () => {
  const t1 = await setup();
  await t1.open('https://example.com/a', { transition: 'typed' });
  await t1.open('https://example.com/b', { transition: 'typed' });

  const b2 = nextSession(t1.browser, { restore: [{ url: 'https://example.com/b', active: true }] });
  const t2 = await connect(b2);
  await t2.engine.dispatch('startup');
  await t2.settle();
  assert.ok(t2.state.startup, 'adoption under way; the browser quits again before any tick');

  const b3 = nextSession(b2, { restore: [{ url: 'https://example.com/b', active: true }], after: 3 * MIN, firstId: 900 });
  const t3 = await connect(b3);
  await t3.settle();
  b3.time += 3 * MIN;
  await t3.use(1);
  assert.deepEqual((await t3.items()).map((i) => [i.url, i.reason]), [['https://example.com/a', 'session-end']]);
  assert.ok(t3.rec(900), 'the tab that came back both times is still tracked');
});

test('a Shelf tab you close by hand is kept in the Library', async () => {
  const t = await setup();
  const a = await t.open('https://example.com/a', { transition: 'typed' });
  await t.open('https://example.com/b', { transition: 'typed' });
  await t.act('shelve-tab', { tabId: a });
  await t.close(a);
  const [item] = await t.items();
  assert.equal(item.url, 'https://example.com/a');
  assert.equal(item.reason, 'shelf-closed');
});

test('emptying the Shelf never leaves a saved "Shelf" group behind in Chrome', async () => {
  const t = await setup();
  const a = await t.open('https://example.com/a', { transition: 'typed' });
  const b = await t.open('https://example.com/b', { transition: 'typed' });
  await t.open('https://example.com/c', { transition: 'typed' });
  await t.act('shelve-tab', { tabId: a });
  await t.act('shelve-tab', { tabId: b });
  await t.act('archive-tab', { tabId: a });
  await t.act('archive-tab', { tabId: b });
  assert.deepEqual(t.browser.savedGroups, []);
  assert.equal(t.state.shelf[t.browser.focusedWindow], undefined);
  assert.equal((await t.events('restore')).length, 0, 'ungrouping on the way out is not a restore');
  assert.deepEqual((await t.items()).map((i) => i.reason), ['manual', 'manual']);

  // Chrome's own behavior is left alone for your groups: closing their last tab keeps them saved.
  const mine = await t.open('https://example.com/mine', { active: false, transition: 'typed' });
  const groupId = t.browser.groupTabs({ tabIds: [mine] });
  t.browser.groups.get(groupId).title = 'Research';
  await t.close(mine);
  assert.deepEqual(t.browser.savedGroups, ['Research']);
});

test('the visible-tab budget counts loose tabs, not tabs in your own groups', async () => {
  const t = await setup({ settings: { budget: 5 } });
  const grouped = [];
  for (let i = 0; i < 6; i++) {
    grouped.push(await t.open(`https://example.com/g${i}`));
    await t.use(1);
  }
  t.browser.groupTabs({ tabIds: grouped });
  for (let i = 0; i < 4; i++) {
    await t.open(`https://example.com/loose${i}`);
    await t.use(1);
  }
  await t.skip(70);
  await t.stepAway();
  assert.equal(t.shelfTabs().length, 0, 'four loose tabs are within a budget of five');
});

test('tabs that were never loaded, or that another tool keeps loaded, are not unloaded', async () => {
  const t = await setup();
  const lazy = await t.open('https://example.com/lazy', { transition: 'typed' });
  const pinnedByTool = await t.open('https://example.com/kept-loaded', { transition: 'typed' });
  await t.open('https://example.com/here', { transition: 'typed' });
  t.browser.tabs.get(lazy).status = 'unloaded'; // restored but never loaded
  t.browser.tabs.get(pinnedByTool).autoDiscardable = false;
  await t.skip(40);
  assert.equal(t.tab(lazy).discarded, false);
  assert.equal(t.rec(lazy).stage, 'resting', 'it already holds no page');
  assert.equal(t.tab(pinnedByTool).discarded, false);
  assert.equal((await t.events('rest')).length, 0);
  const vm = await t.message({ type: 'panel:state' });
  const row = vm.windows[0].hunts.flatMap((h) => h.tabs).find((r) => r.tabId === pinnedByTool);
  assert.equal(row.protected, 'kept active');
});

test('restoring a page that is already open again switches to it instead of opening it twice', async () => {
  const t = await setup();
  const a = await t.open('https://example.com/a', { transition: 'typed' });
  await t.open('https://example.com/b', { transition: 'typed' });
  const { id } = await t.act('archive-tab', { tabId: a });
  const again = await t.open('https://example.com/a', { transition: 'typed' });
  await t.open('https://example.com/c', { transition: 'typed' });
  await t.act('restore-item', { id });
  assert.equal(t.browser.queryTabs({}).filter((x) => x.url === 'https://example.com/a').length, 1);
  assert.equal(t.tab(again).active, true);
  assert.equal((await t.items()).length, 0);

  await t.engine.dispatch('addLater', { url: 'https://example.com/c', title: 'C' });
  await t.act('open-later', { id: (await t.items('later'))[0].id });
  assert.equal(t.browser.queryTabs({}).filter((x) => x.url === 'https://example.com/c').length, 1);
  assert.equal((await t.items('later')).length, 0);
});

test('a page closed from the Shelf comes back outside it, in the window you asked from', async () => {
  const t = await setup();
  const a = await t.open('https://example.com/a', { transition: 'typed' });
  const b = await t.open('https://example.com/b', { transition: 'typed' });
  await t.open('https://example.com/c', { transition: 'typed' });
  await t.act('shelve-tab', { tabId: a });
  await t.act('shelve-tab', { tabId: b });
  const { id } = await t.act('archive-tab', { tabId: a }); // the Shelf, with b, is still there

  const w2 = t.browser.openWindow();
  await t.settle();
  await t.open('https://example.com/d', { windowId: w2, transition: 'typed' });
  await t.act('restore-item', { id, windowId: w2 });
  const back = t.browser.queryTabs({}).find((x) => x.url === 'https://example.com/a');
  assert.equal(back.windowId, w2);
  assert.equal(back.groupId, -1, 'not left in the collapsed Shelf');
  assert.equal(back.active, true);
  assert.ok(!t.browser.closed.some((x) => x.tab.url === 'https://example.com/a'), 'restored with its history');
});

test('taking a tab off the Shelf folds the rest of the Shelf away again', async () => {
  const t = await setup();
  const a = await t.open('https://example.com/a', { transition: 'typed' });
  const b = await t.open('https://example.com/b', { transition: 'typed' });
  await t.open('https://example.com/c', { transition: 'typed' });
  await t.act('shelve-tab', { tabId: a });
  await t.act('shelve-tab', { tabId: b });
  const shelf = t.browser.groups.get(t.state.shelf[t.browser.focusedWindow]);
  await t.activate(a); // Chrome expands the group to show the selected tab
  assert.equal(t.tab(a).groupId, -1);
  assert.equal(shelf.collapsed, true);
});

test('a page can only act on its own task from a toast', async () => {
  const t = await setup({ settings: { laterMode: 'off' } });
  const s = await t.open('https://www.google.com/search?q=desk', { transition: 'generated' });
  const r1 = await t.background(s, 'https://shop.example/1');
  await t.background(s, 'https://shop.example/2');
  const other = await t.open('https://example.org/x', { transition: 'typed' });
  const res = await t.toastAction(other, 'tuck', { huntId: t.rec(s).huntId });
  assert.match(res.toast.text, /Nothing to tuck away/);
  assert.ok(t.tab(r1));

  const { batchId } = await t.act('tuck-hunt', { huntId: t.rec(s).huntId });
  const refused = await t.toastAction(other, 'undo', { batchId });
  assert.match(refused.toast.text, /Nothing to bring back/);
  assert.equal(t.tab(r1), null);
});

test('the receipt of a finished task keeps the confirmation page’s text', async () => {
  const t = await setup();
  const confirm = 'https://shop.example/order/confirmation?id=42';
  t.browser.page(confirm, { title: 'Order confirmed', headings: ['Thank you for your order!'], hasReference: true, excerpt: 'Order number: 12345. Arrives Friday.' });
  const s = await t.open('https://www.google.com/search?q=standing+desk', { transition: 'generated' });
  const buy = await t.background(s, 'https://shop.example/desk-1');
  await t.background(s, 'https://shop.example/desk-2');
  await t.activate(buy);
  await t.navigate(buy, confirm, { transition: 'form_submit' });
  const offer = t.browser.toasts.find((x) => x.tabId === buy);
  await t.toastAction(buy, 'tuck', offer.toast.actions[0].data);
  const receipt = (await t.items()).find((i) => i.reason === 'receipt');
  assert.match(receipt.excerpt, /Order number: 12345/);
});

// ---------------------------------------------------------------- storage

test('the Library keeps one entry per page', async () => {
  const t = await setup();
  const a = await t.open('https://example.com/a?utm_source=newsletter', { transition: 'typed' });
  await t.open('https://example.com/b', { transition: 'typed' });
  await t.act('archive-tab', { tabId: a });
  const again = await t.open('https://example.com/a', { transition: 'typed' });
  await t.open('https://example.com/c', { transition: 'typed' });
  await t.act('archive-tab', { tabId: again });
  const items = await t.items();
  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'https://example.com/a');
});

test('text snippets stay out of the frequently saved state, and turning them off removes them', async () => {
  const t = await setup();
  t.browser.page('https://example.com/a', { title: 'A', excerpt: 'Secret words about tides' });
  const a = await t.open('https://example.com/a', { transition: 'typed' });
  await t.open('https://example.com/b', { transition: 'typed' });
  assert.ok(!JSON.stringify(t.browser.storageData['ebb:state']).includes('Secret words'));
  assert.equal((await t.items('snapshots'))[0].excerpt, 'Secret words about tides');

  await t.message({ type: 'panel:settings', patch: { captureText: false } });
  assert.equal((await t.items('snapshots')).length, 0);
  await t.act('archive-tab', { tabId: a });
  assert.equal((await t.items())[0].excerpt, '');
});

test('state saved by version 0.1 is upgraded', async () => {
  const t1 = await setup();
  const a = await t1.open('https://example.com/a', { transition: 'typed' });
  await t1.open('https://example.com/b', { transition: 'typed' });
  const old = structuredClone(t1.browser.storageData['ebb:state']);
  old.version = 1;
  delete old.intro;
  delete old.introPending;
  Object.assign(old.tabs[a], { excerpt: 'Old snippet', description: 'Old description' });
  t1.browser.storageData['ebb:state'] = old;
  await t1.browser.repo.clear('snapshots');

  const t2 = await connect(t1.browser);
  await t2.use(1);
  assert.equal(t2.state.version, 2);
  assert.equal('excerpt' in t2.rec(a), false);
  assert.equal((await t2.browser.repo.get('snapshots', 'https://example.com/a')).excerpt, 'Old snippet');
  assert.deepEqual(t2.state.intro, { shelf: false, library: false });
  await t2.act('archive-tab', { tabId: a });
  assert.equal((await t2.items())[0].description, 'Old description');
});

// ---------------------------------------------------------------- first-time explanations

test('the first time Ebb moves tabs on its own, it explains once you are back', async () => {
  const t = await setup({ settings: { budget: 0 } });
  const a = await t.open('https://example.com/a', { transition: 'typed' });
  const here = await t.open('https://example.com/here', { transition: 'typed' });
  await t.skip(200);
  await t.stepAway();
  assert.notEqual(t.tab(a).groupId, -1);
  assert.equal(t.browser.toasts.length, 0, 'nothing is shown while you are away');

  await t.comeBack();
  assert.equal(t.browser.toasts.length, 1);
  const [intro] = t.browser.toasts;
  assert.equal(intro.tabId, here);
  assert.match(intro.toast.text, /moved 1 idle tab to the Shelf/);
  await t.toastAction(here, 'show-shelf');
  assert.equal(t.browser.groups.get(t.tab(a).groupId).collapsed, false, '“Show me” opens the Shelf');

  const b = await t.open('https://example.com/b', { transition: 'typed' });
  await t.activate(here);
  await t.skip(200);
  await t.stepAway();
  assert.notEqual(t.tab(b).groupId, -1);
  await t.comeBack();
  assert.equal(t.browser.toasts.length, 1, 'explained only once');

  await t.skip(1300);
  await t.stepAway();
  await t.comeBack();
  const last = t.browser.toasts.at(-1);
  assert.match(last.toast.text, /^Ebb closed 2 tabs that sat unused on the Shelf.*“ebb”/);
});

test('an explanation waits for a page it can be shown on', async () => {
  const t = await setup({ settings: { budget: 0 } });
  await t.open('https://example.com/a', { transition: 'typed' });
  const newTab = await t.open('chrome://newtab/', { transition: 'typed' });
  await t.skip(200);
  await t.stepAway();
  await t.comeBack();
  assert.equal(t.browser.toasts.length, 0, 'the new tab page has no content script');
  await t.navigate(newTab, 'https://example.com/next', { transition: 'typed' });
  await t.activate(newTab);
  assert.equal(t.browser.toasts.length, 1);
});

// ---------------------------------------------------------------- the address bar

test('typing “ebb” and words in the address bar finds Later links and Library pages', async () => {
  const t = await setup();
  t.browser.page('https://example.com/tides', { title: 'Tide tables & <times>', excerpt: 'Spring tides happen near the full moon.' });
  const a = await t.open('https://example.com/tides', { transition: 'typed' });
  await t.open('https://example.com/other', { transition: 'typed' });
  await t.act('archive-tab', { tabId: a });
  await t.engine.dispatch('addLater', { url: 'https://blog.example/moon', title: 'Moon phases explained' });

  const suggestions = await t.engine.dispatch('omniboxSuggest', 'moon');
  assert.deepEqual(suggestions.map((s) => s.content), ['https://blog.example/moon', 'https://example.com/tides']);
  assert.match(suggestions[0].description, /^Moon phases explained <dim>· Later<\/dim>/);
  assert.match(suggestions[1].description, /^Tide tables &amp; &lt;times&gt; <dim>· Library/, 'titles are escaped for the address bar');
  assert.deepEqual(await t.engine.dispatch('omniboxSuggest', '   '), []);

  // Enter on a suggestion in the current tab (a new tab page here) loads it right there.
  const blank = await t.open('chrome://newtab/', { transition: 'typed' });
  await t.engine.dispatch('omniboxEnter', 'https://example.com/tides', 'currentTab', t.tab(blank));
  await t.settle();
  assert.equal(t.tab(blank).url, 'https://example.com/tides');
  assert.equal((await t.items()).length, 0);

  // Free text opens the best match, here the Later link, behind the current tab.
  await t.engine.dispatch('omniboxEnter', 'moon phases', 'newBackgroundTab', t.tab(blank));
  await t.settle();
  const moon = t.browser.queryTabs({}).find((x) => x.url === 'https://blog.example/moon');
  assert.equal(moon.active, false);
  assert.equal((await t.items('later')).length, 0);

  const none = await t.engine.dispatch('omniboxEnter', 'nothing like this', 'currentTab', t.tab(blank));
  await t.settle();
  assert.equal(none.ok, false);
  assert.match(t.browser.toasts.at(-1).toast.text, /Nothing in Ebb matches “nothing like this”/);
});

test('panel actions that close a tab say what they did, so the panel can offer Undo', async () => {
  const t = await setup();
  const a = await t.open('https://example.com/a', { transition: 'typed' });
  const b = await t.open('https://example.com/b', { transition: 'typed' });
  await t.open('https://example.com/c', { transition: 'typed' });
  const archived = await t.act('archive-tab', { tabId: a });
  const later = await t.act('later-tab', { tabId: b });
  assert.match(archived.id, /^lib_/);
  assert.match(later.id, /^later_/);
  await t.act('restore-item', { id: archived.id });
  await t.act('open-later', { id: later.id });
  const urls = t.browser.queryTabs({}).map((x) => x.url);
  assert.ok(urls.includes('https://example.com/a') && urls.includes('https://example.com/b'));
});

test('importing an older copy of a page keeps the newer Library entry', async () => {
  const t = await setup();
  const a = await t.open('https://example.com/a', { transition: 'typed' });
  await t.open('https://example.com/b', { transition: 'typed' });
  await t.act('archive-tab', { tabId: a });
  const [current] = await t.items();
  const older = { ...current, id: 'lib_old', title: 'An older title', archivedAt: current.archivedAt - 1000, key: undefined };
  const newer = { id: 'lib_other', url: 'https://example.com/z', title: 'Z', archivedAt: current.archivedAt };
  const res = await t.message({ type: 'panel:import', data: { app: 'ebb', library: [older, newer] } });
  assert.equal(res.counts.library, 1);
  const items = await t.items();
  assert.deepEqual(items.map((i) => i.title).sort(), [current.title, 'Z'].sort());
});
