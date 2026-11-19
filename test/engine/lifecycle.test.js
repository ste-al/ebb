import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from '../fakes/harness.js';
import { MIN, HOUR } from '../../extension/lib/util.js';

test('a tab you leave alone rests, then moves to the Shelf at a boundary, then to the Library', async () => {
  const t = await setup();
  const a = await t.open('https://example.com/article');
  t.browser.scroll(a, 1200, 0.4);
  const b = await t.open('https://example.com/b'); // leaving `a` captures where you were

  await t.use(29);
  assert.equal(t.tab(a).discarded, false, 'still loaded before 30 active minutes');
  await t.use(2);
  assert.equal(t.tab(a).discarded, true, 'unloaded in place after 30 active minutes');
  assert.equal(t.rec(a).stage, 'resting');
  assert.equal(t.tab(a).groupId, -1, 'resting tabs stay where they are');
  assert.equal(t.tab(b).discarded, false, 'the tab you are on is never touched');

  await t.skip(150);
  assert.equal(t.tab(a).groupId, -1, 'no moving tabs around while you are using Chrome');

  await t.stepAway();
  const shelf = t.state.shelf[t.browser.focusedWindow];
  assert.equal(t.tab(a).groupId, shelf, 'shelved at the boundary');
  const group = t.browser.groups.get(shelf);
  assert.equal(group.title, 'Shelf · 1');
  assert.equal(group.collapsed, true);
  assert.deepEqual(t.browser.strip().at(-1), a, 'the Shelf sits at the end of the tab bar');
  await t.comeBack();

  await t.skip(1300);
  assert.ok(t.tab(a), 'still on the Shelf while you are active');
  await t.stepAway();
  assert.equal(t.tab(a), null, 'closed into the Library');
  const [item] = await t.items();
  assert.equal(item.url, 'https://example.com/article');
  assert.equal(item.reason, 'idle');
  assert.equal(item.freeze.scrollY, 1200, 'your place on the page is kept');
  assert.deepEqual((await t.events()).map((e) => e.type).sort(), ['archive', 'rest', 'shelve']);
  assert.equal((await t.events('archive'))[0].from, 'shelved');
});

test('Ebb never touches pinned, playing, typing, kept, app or exempt tabs', async () => {
  const t = await setup({ settings: { exemptHosts: ['example.org'] } });
  const pinned = await t.open('https://example.com/pinned', { pinned: true });
  const playing = await t.open('https://example.com/music');
  t.browser.setAudible(playing);
  const typing = await t.open('https://example.com/form');
  t.browser.type(typing); // noticed when you leave the tab
  const kept = await t.open('https://example.com/kept');
  const app = await t.open('https://mail.google.com/mail/u/0/#inbox');
  const exempt = await t.open('https://wiki.example.org/page');
  const plain = await t.open('https://example.com/plain');
  await t.open('https://example.com/here');
  await t.act('keep-tab', { tabId: kept, mode: 'week' });

  await t.skip(3000);
  await t.stepAway();
  for (const id of [pinned, playing, typing, kept, app, exempt]) {
    assert.equal(t.tab(id).discarded, false, `tab ${t.tab(id).url} stays loaded`);
    assert.equal(t.tab(id).groupId, -1, `tab ${t.tab(id).url} stays in place`);
  }
  assert.equal(t.rec(typing).dirty, true);
  assert.equal(t.tab(plain).groupId, t.state.shelf[t.browser.focusedWindow], 'an ordinary tab is tidied');
});

test('unsaved input reported by the page protects the tab until it is cleared', async () => {
  const t = await setup();
  const form = await t.open('https://example.com/compose');
  await t.open('https://example.com/other');
  await t.message({ type: 'ebb:dirty', dirty: true }, { tab: t.tab(form) });
  await t.skip(40);
  assert.equal(t.tab(form).discarded, false);
  await t.message({ type: 'ebb:dirty', dirty: false }, { tab: t.tab(form) });
  await t.use(1);
  assert.equal(t.tab(form).discarded, true);
});

test('a last-minute draft survives direct-to-Library tidying even after an earlier clean capture', async () => {
  const t = await setup({ settings: { useShelf: false } });
  const draft = await t.open('https://example.com/compose');
  await t.open('https://example.com/reading');
  assert.ok(t.rec(draft).freeze);
  t.browser.type(draft);
  t.state.clock.activeMs += 25 * HOUR;
  await t.stepAway();
  assert.ok(t.tab(draft));
  assert.equal(t.tab(draft).discarded, false);
  assert.equal(t.rec(draft).dirty, true);
  assert.deepEqual(await t.items(), []);
  assert.deepEqual(await t.events('rest'), []);
});

test('the clock only runs while Chrome is focused and you are at the keyboard', async () => {
  const t = await setup();
  await t.use(10);
  assert.equal(t.state.clock.activeMs, 10 * MIN);

  t.browser.focus(-1); // switched to another app
  await t.settle();
  await t.use(10);
  assert.equal(t.state.clock.activeMs, 10 * MIN);

  t.browser.focus(t.browser.focusedWindow);
  await t.settle();
  await t.use(5);
  assert.equal(t.state.clock.activeMs, 15 * MIN);

  t.browser.idle('locked');
  await t.settle();
  await t.use(30);
  assert.equal(t.state.clock.activeMs, 15 * MIN, 'a locked screen does not count');
  await t.comeBack();

  t.browser.time += 8 * HOUR; // the laptop slept; one late alarm must not count the whole gap
  t.browser.tick();
  await t.settle();
  assert.equal(t.state.clock.activeMs, 17 * MIN);
});

test('idle time starts when you leave a tab, not when you opened it', async () => {
  const t = await setup();
  const a = await t.open('https://example.com/long-read');
  await t.use(45); // reading it the whole time
  await t.open('https://example.com/next');
  await t.use(5);
  assert.equal(t.tab(a).discarded, false);
  await t.use(26);
  assert.equal(t.tab(a).discarded, true);
});

test('tabs you keep coming back to live longer', async () => {
  const t = await setup();
  const favorite = await t.open('https://example.com/favorite');
  const once = await t.open('https://example.com/once');
  const other = await t.open('https://example.com/other');
  for (let i = 0; i < 2; i++) {
    await t.use(3);
    await t.activate(favorite);
    await t.use(3);
    await t.activate(other);
  }
  assert.equal(t.rec(favorite).visits, 3);
  assert.equal(t.rec(once).visits, 1);
  await t.skip(40);
  assert.equal(t.tab(once).discarded, true, 'opened once: rests after 30 minutes');
  assert.equal(t.tab(favorite).discarded, false, 'visited three times: rests after six hours');
});

test('what a page is changes how long it stays: news fades fast, references last', async () => {
  const t = await setup();
  const news = await t.open('https://www.bbc.com/news/world-1');
  const ref = await t.open('https://en.wikipedia.org/wiki/Tide');
  const page = await t.open('https://example.com/page');
  await t.open('https://example.com/here');
  await t.skip(16);
  assert.equal(t.tab(news).discarded, true);
  assert.equal(t.tab(page).discarded, false);
  await t.skip(15);
  assert.equal(t.tab(page).discarded, true);
  assert.equal(t.tab(ref).discarded, false);
  await t.skip(30);
  assert.equal(t.tab(ref).discarded, true);
});

test('pace scales every lifetime', async () => {
  const t = await setup({ settings: { pace: 'gentle' } });
  const a = await t.open('https://example.com/a');
  await t.open('https://example.com/b');
  await t.skip(45);
  assert.equal(t.tab(a).discarded, false);
  await t.skip(16);
  assert.equal(t.tab(a).discarded, true);
});

test('tabs in your own tab groups rest but are never moved', async () => {
  const t = await setup();
  const a = await t.open('https://example.com/grouped');
  const groupId = t.browser.groupTabs({ tabIds: [a] });
  t.browser.groups.get(groupId).title = 'Research';
  await t.open('https://example.com/here');
  await t.skip(3000);
  await t.stepAway();
  assert.equal(t.tab(a).discarded, true);
  assert.equal(t.tab(a).groupId, groupId);
});

test('without the Shelf, tabs go straight to the Library at the archive age', async () => {
  const t = await setup({ settings: { useShelf: false } });
  const a = await t.open('https://example.com/a');
  await t.open('https://example.com/b');
  await t.skip(500);
  await t.stepAway();
  assert.equal(t.tab(a).groupId, -1, 'no Shelf');
  await t.comeBack();
  await t.skip(1000);
  await t.stepAway();
  assert.equal(t.tab(a), null);
  assert.equal((await t.items()).length, 1);
});

test('a tab that refuses to unload is not retried every minute', async () => {
  const t = await setup();
  const a = await t.open('https://example.com/stubborn');
  await t.open('https://example.com/b');
  t.browser.noDiscard.add(a);
  await t.use(31);
  assert.equal(t.tab(a).discarded, false);
  const asked = () => t.browser.messages.filter((m) => m.tabId === a && m.msg.type === 'ebb:capture').length;
  const before = asked();
  await t.use(10);
  assert.equal(asked(), before, 'no repeated page round trips');
  t.browser.noDiscard.delete(a);
  await t.skip(30);
  assert.equal(t.tab(a).discarded, true, 'tried again later');
});

test('the soft budget shelves the least recently used tabs when a window gets crowded', async () => {
  const t = await setup({ settings: { budget: 5 } });
  const ids = [];
  for (let i = 0; i < 9; i++) {
    ids.push(await t.open(`https://example.com/${i}`));
    await t.use(1);
  }
  await t.skip(25); // past the 20-minute floor, but before the install grace ends
  await t.stepAway();
  assert.equal(t.shelfTabs().length, 0, 'not in the first hour after install');
  await t.comeBack();
  await t.skip(40);
  await t.stepAway();
  assert.deepEqual(new Set(t.shelfTabs()), new Set(ids.slice(0, 4)), 'the four least recently used tabs');
  assert.equal(t.browser.queryTabs({}).filter((tab) => tab.groupId === -1).length, 5);
});

test('pausing stops everything', async () => {
  const t = await setup({ settings: { paused: true } });
  const a = await t.open('https://example.com/a');
  await t.open('https://example.com/b');
  await t.skip(3000);
  await t.stepAway();
  assert.equal(t.tab(a).discarded, false);
  assert.equal(t.tab(a).groupId, -1);
});

test('at most 25 tabs move per pass so a big backlog is cleared gradually', async () => {
  const t = await setup();
  for (let i = 0; i < 40; i++) await t.open(`https://example.com/${i}`, { active: i === 39 });
  await t.skip(200);
  await t.stepAway();
  assert.equal(t.shelfTabs().length, 25);
  t.browser.tick();
  await t.settle();
  assert.equal(t.shelfTabs().length, 39);
});
