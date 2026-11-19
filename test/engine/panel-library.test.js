import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from '../fakes/harness.js';
import { MIN } from '../../extension/lib/util.js';

test('clicking a shelved tab brings it back next to its task, where you left off', async () => {
  const t = await setup({ settings: { laterMode: 'off' } });
  const s = await t.open('https://www.google.com/search?q=tide+pools', { transition: 'generated' });
  const r1 = await t.background(s, 'https://example.com/pools-1');
  const r2 = await t.background(s, 'https://example.com/pools-2');
  const x = await t.open('https://example.org/elsewhere', { transition: 'typed' });
  await t.activate(r1);
  t.browser.scroll(r1, 900, 0.3);
  await t.activate(x);

  await t.act('shelve-tab', { tabId: r1 });
  assert.equal(t.browser.strip().at(-1), r1, 'shelved at the end of the tab bar');
  assert.equal(t.tab(r1).discarded, true);

  await t.activate(r1); // expand the Shelf and click the tab
  const strip = t.browser.strip();
  assert.equal(t.tab(r1).groupId, -1);
  assert.equal(strip.indexOf(r1), strip.indexOf(r2) + 1, 'placed after the other tabs of its task');
  assert.equal(t.rec(r1).stage, 'live');
  assert.equal(t.browser.restores.find((r) => r.tabId === r1)?.freeze.scrollY, 900, 'scrolled back to where you were');
  const [restore] = await t.events('restore');
  assert.equal(restore.from, 'shelf');
  assert.equal(t.state.shelf[t.browser.focusedWindow], undefined, 'the empty Shelf is gone');
});

test('restoring from the Library reopens the page with its history, task and place', async () => {
  const t = await setup();
  const a = await t.open('https://example.com/essay', { transition: 'typed' });
  t.browser.scroll(a, 2400, 0.6);
  await t.open('https://example.com/b', { transition: 'typed' });
  await t.act('archive-tab', { tabId: a });
  const [item] = await t.items();
  assert.equal(item.freeze.scrollY, 2400);
  assert.equal(item.reason, 'manual');

  const res = await t.act('restore-item', { id: item.id });
  assert.equal(res.ok, true);
  const back = t.browser.queryTabs({}).find((tab) => tab.url === 'https://example.com/essay');
  assert.ok(back.active);
  assert.equal(t.rec(back.id).huntId, item.huntId, 'back in its task');
  assert.deepEqual(t.browser.restores.map((r) => [r.tabId, r.freeze.scrollY]), [[back.id, 2400]]);
  assert.ok(!t.browser.closed.some((x) => x.tab.url === 'https://example.com/essay'), 'reopened from recently closed, history and all');
  assert.equal((await t.items()).length, 0);
  assert.equal((await t.events('restore'))[0].from, 'library');
});

test('tabs brought back from the Library open before the Shelf, so it stays at the end', async () => {
  const t = await setup();
  const a = await t.open('https://example.com/a', { transition: 'typed' });
  const b = await t.open('https://example.com/b', { transition: 'typed' });
  await t.open('https://example.com/c', { transition: 'typed' });
  await t.act('shelve-tab', { tabId: b });
  await t.act('archive-tab', { tabId: a });
  t.browser.closed = []; // not in recently closed any more, so it is opened fresh
  const [item] = await t.items();
  await t.act('restore-item', { id: item.id });
  const strip = t.browser.strip();
  const back = t.browser.queryTabs({}).find((tab) => tab.url === 'https://example.com/a');
  assert.equal(strip.at(-1), b, 'the Shelf is still last');
  assert.equal(strip.indexOf(back.id), strip.length - 2);
  assert.equal(back.groupId, -1);
});

test('a pending scroll restore is never applied to a different page', async () => {
  const t = await setup();
  const a = await t.open('https://example.com/long', { transition: 'typed' });
  await t.engine.dispatch('queueRestore', a, { scrollY: 3000, scrollRatio: 0.7, media: [], at: 0 }, 'https://example.com/long');
  await t.navigate(a, 'https://example.com/other-page', { transition: 'typed' });
  assert.equal(t.browser.restores.length, 0);
  assert.deepEqual(t.state.pendingRestore, {});
});

test('library search finds pages by title, address, task and the text Ebb kept', async () => {
  const t = await setup();
  t.browser.page('https://example.com/tides', { title: 'Tide tables', excerpt: 'Spring tides happen near the new and full moon.' });
  const a = await t.open('https://example.com/tides', { transition: 'typed' });
  await t.open('https://example.com/other', { transition: 'typed' }); // leaving the page captures its text
  await t.act('archive-tab', { tabId: a });
  assert.equal((await t.message({ type: 'panel:library', q: 'full moon' })).total, 1);
  assert.equal((await t.message({ type: 'panel:library', q: 'EXAMPLE.com tide' })).total, 1);
  assert.equal((await t.message({ type: 'panel:library', q: 'nothing like this' })).total, 0);
  assert.equal((await t.message({ type: 'panel:library' })).items[0].title, 'Tide tables');
});

test('without text snippets, nothing of the page text is kept', async () => {
  const t = await setup({ settings: { captureText: false } });
  t.browser.page('https://example.com/private', { title: 'Private', excerpt: 'Secret words', description: 'More secret words' });
  const a = await t.open('https://example.com/private', { transition: 'typed' });
  await t.open('https://example.com/other', { transition: 'typed' });
  await t.act('archive-tab', { tabId: a });
  const [item] = await t.items();
  assert.equal(item.excerpt, '');
  assert.equal(item.description, '');
  assert.ok(t.browser.messages.every((m) => m.msg.type !== 'ebb:capture' || m.msg.text === false));
});

test('the panel says what happens next to each tab', async () => {
  const t = await setup();
  const a = await t.open('https://example.com/a', { transition: 'typed' });
  const b = await t.open('https://example.com/b', { transition: 'typed' });
  await t.use(10);
  const vm = await t.message({ type: 'panel:state' });
  const rows = vm.windows[0].hunts.flatMap((h) => h.tabs);
  assert.deepEqual(rows.find((r) => r.tabId === a).next, { stage: 'resting', inMs: 20 * MIN });
  const here = rows.find((r) => r.tabId === b);
  assert.equal(here.active, true);
  assert.equal(here.next, null);
  assert.equal(vm.activeMinutes, 10);
});

test('settings are validated and only saved when they change', async () => {
  const t = await setup();
  const s = await t.message({
    type: 'panel:settings',
    patch: { pace: 'warp', budget: '-4', laterMode: 'always', exemptHosts: [' Example.COM ', '', 'example.com'], bogus: true },
  });
  assert.equal(s.pace, 'balanced');
  assert.equal(s.budget, 0);
  assert.equal(s.laterMode, 'always');
  assert.deepEqual(s.exemptHosts, ['example.com']);
  assert.equal('bogus' in s, false);
  const saves = t.browser.notifications.length;
  await t.message({ type: 'panel:settings', patch: {} });
  assert.equal(t.browser.notifications.length, saves, 'no write when nothing changed');
});

test('the ledger counts what Ebb tidied and you brought back; sites you bring back live longer', async () => {
  const t = await setup();
  const here = await t.open('https://example.com/here', { transition: 'typed' });
  for (let i = 0; i < 3; i++) {
    const id = await t.open(`https://often.example/${i}`, { transition: 'typed', active: false });
    await t.act('shelve-tab', { tabId: id });
    await t.act('activate-tab', { tabId: id });
    await t.activate(here);
  }
  const vm = await t.message({ type: 'panel:state' });
  assert.equal(vm.ledger.week.tidied, 3);
  assert.equal(vm.ledger.week.restored, 3);
  assert.match(vm.ledger.sentence, /you brought back 3 \(100%\)/);

  t.browser.time += 11 * MIN;
  await t.engine.dispatch('refreshHostMult');
  assert.equal(t.state.hostMult['often.example'], 3);
  const fresh = await t.open('https://often.example/new', { transition: 'typed' });
  await t.activate(here);
  await t.skip(31);
  assert.equal(t.tab(fresh).discarded, false, 'three times the usual lifetime');
  await t.skip(60);
  assert.equal(t.tab(fresh).discarded, true);
});

test('export and import round-trip the Library, Later and the ledger, skipping anything unsafe', async () => {
  const t = await setup();
  const a = await t.open('https://example.com/a', { transition: 'typed' });
  await t.open('https://example.com/b', { transition: 'typed' });
  await t.act('archive-tab', { tabId: a });
  await t.engine.dispatch('addLater', { url: 'https://example.com/later', title: 'Later' });
  const data = await t.message({ type: 'panel:export' });
  assert.equal(data.app, 'ebb');
  assert.equal(data.library.length, 1);
  assert.equal(data.later.length, 1);

  const t2 = await setup();
  const res = await t2.message({ type: 'panel:import', data: JSON.parse(JSON.stringify(data)) });
  assert.deepEqual(res.counts, { library: 1, later: 1, ledger: data.ledger.length });
  assert.equal(t2.state.counts.later, 1);
  assert.equal((await t2.message({ type: 'panel:import', data: { app: 'other' } })).ok, false);
  const unsafe = await t2.message({
    type: 'panel:import',
    data: { app: 'ebb', library: [{ id: 'x', url: 'javascript:alert(1)', archivedAt: 1 }], later: [{ id: 'y', url: 'file:///etc/passwd', savedAt: 1 }] },
  });
  assert.deepEqual(unsafe.counts, { library: 0, later: 0, ledger: 0 });
});

test('keeping a tab from the page shows a toast and protects it; keeping again releases it', async () => {
  const t = await setup();
  const a = await t.open('https://example.com/a', { transition: 'typed' });
  await t.engine.dispatch('keepFromPage', a, 'toggle');
  await t.settle();
  assert.match(t.browser.toasts.at(-1).toast.text, /Kept for a week/);
  await t.open('https://example.com/b', { transition: 'typed' });
  await t.skip(40);
  assert.equal(t.tab(a).discarded, false);
  await t.engine.dispatch('keepFromPage', a, 'toggle');
  await t.settle();
  assert.match(t.browser.toasts.at(-1).toast.text, /No longer kept/);
});

test('messages of unknown types are ignored', async () => {
  const t = await setup();
  assert.equal(await t.message({ type: 'something-else' }), undefined);
  assert.deepEqual(await t.act('no-such-action'), { ok: false, error: 'unknown action no-such-action' });
});

test('import uses the page address and keeps the newest copy even when a backup reuses its ID', async () => {
  const t = await setup();
  const tab = await t.open('https://example.com/notes');
  const { id } = await t.act('archive-tab', { tabId: tab });
  const [saved] = await t.items();
  const backup = { ...saved, archivedAt: saved.archivedAt - 1000, title: 'Old notes' };
  const alternate = { ...backup, id: 'another-copy', url: saved.url + '?utm_source=backup', key: 'obsolete-key' };
  const response = await t.message({ type: 'panel:import', data: { app: 'ebb', library: [backup, alternate] } });
  assert.equal(response.counts.library, 0);
  assert.deepEqual(await t.items(), [saved]);
  assert.equal(saved.id, id);
});

test('a refused close keeps the live tab, its previous Library entry, and the Later count', async () => {
  const t = await setup();
  const url = 'https://example.com/notes';
  await t.act('archive-tab', { tabId: await t.open(url) });
  const saved = await t.items();
  const tabId = await t.open(url);
  t.engine.p.tabs.remove = async () => false;
  assert.equal((await t.act('archive-tab', { tabId })).ok, false);
  assert.equal((await t.act('later-tab', { tabId })).ok, false);
  assert.equal(t.rec(tabId).url, url);
  assert.deepEqual(await t.items(), saved);
  assert.deepEqual(await t.items('later'), []);
  assert.equal(t.state.counts.later, 0);
  assert.equal((await t.events('archive')).length, 1);
  assert.equal((await t.events('later')).length, 0);
  await t.close(tabId);
  assert.equal(t.rec(tabId), undefined);
});

test('Fresh start leaves a tab in view if it was selected while its Library copy was being saved', async () => {
  const t = await setup();
  const url = 'https://example.com/reading';
  const tabId = await t.open(url);
  await t.open('https://example.com/other');
  const put = t.browser.repo.put;
  t.browser.repo.put = async (store, item, ...args) => {
    await put(store, item, ...args);
    if (store === 'library' && item.url === url) t.browser.activate(tabId);
  };
  assert.equal((await t.act('fresh-start')).count, 0);
  assert.ok(t.tab(tabId).active);
  assert.deepEqual(await t.items(), []);
  assert.deepEqual(await t.events('archive'), []);
});

test('pressing Enter on free text opens the first suggestion, and a receipt suggestion can be opened', async () => {
  const t = await setup();
  const receipt = { id: 'receipt-1', reason: 'receipt', title: 'Trip receipt', url: 'https://example.com/receipt', archivedAt: 1 };
  await t.message({ type: 'panel:import', data: { app: 'ebb', library: [receipt] } });
  await t.engine.dispatch('addLater', { title: 'Trip checklist', url: 'https://example.com/checklist' });
  const current = await t.open('https://example.com/start');
  const choose = async (text) => {
    const result = await t.engine.dispatch('omniboxEnter', text, 'currentTab', t.tab(current));
    await t.settle();
    assert.ok(result.ok);
  };
  const [first] = await t.engine.dispatch('omniboxSuggest', 'trip');
  await choose('trip');
  assert.equal(t.tab(current).url, first.content);
  const [second] = await t.engine.dispatch('omniboxSuggest', 'receipt');
  await choose(second.content);
  assert.equal(t.tab(current).url, receipt.url);
});

test('Library and Later keep their entries if an existing tab cannot be selected or reopened', async () => {
  const t = await setup();
  const url = 'https://example.com/saved';
  await t.open(url);
  await t.open('https://example.com/other');
  await t.message({ type: 'panel:import', data: {
    app: 'ebb', library: [{ id: 'page', url, archivedAt: 1 }], later: [{ id: 'link', url, savedAt: 1 }],
  } });
  t.engine.p.tabs.update = async () => null;
  t.engine.p.tabs.create = async () => null;
  assert.equal((await t.act('restore-item', { id: 'page' })).ok, false);
  assert.equal((await t.act('open-later', { id: 'link' })).ok, false);
  assert.deepEqual((await t.items()).map((item) => item.id), ['page']);
  assert.deepEqual((await t.items('later')).map((item) => item.id), ['link']);
  assert.equal(t.state.counts.later, 1);
});
