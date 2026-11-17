import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from '../fakes/harness.js';
import { DAY } from '../../extension/lib/util.js';

const SEARCH = 'https://www.google.com/search?q=trail+running+shoes';

test('a search starts a hunt named by its query, and tabs opened from it join', async () => {
  const t = await setup({ settings: { laterMode: 'off' } });
  const s = await t.open(SEARCH, { transition: 'generated' });
  const r1 = await t.background(s, 'https://shop.example/shoe-a');
  const r2 = await t.background(s, 'https://reviews.example/best-trail-shoes');
  const hunt = t.hunt(s);
  assert.equal(hunt.origin, 'search');
  assert.deepEqual(hunt.queries, ['trail running shoes']);
  assert.equal(t.rec(r1).huntId, hunt.id);
  assert.equal(t.rec(r2).huntId, hunt.id);
  assert.equal(t.rec(r1).visits, 0, 'background tabs have not been looked at yet');
});

test('refining a search keeps the hunt; an unrelated search or a typed address starts a new one', async () => {
  const t = await setup();
  const s = await t.open(SEARCH, { transition: 'generated' });
  const first = t.rec(s).huntId;
  await t.navigate(s, 'https://www.google.com/search?q=trail+running+shoes+wide+feet', { transition: 'form_submit' });
  assert.equal(t.rec(s).huntId, first);
  assert.deepEqual(t.hunt(s).queries, ['trail running shoes', 'trail running shoes wide feet']);

  await t.navigate(s, 'https://www.google.com/search?q=sourdough+starter', { transition: 'form_submit' });
  assert.notEqual(t.rec(s).huntId, first);
  assert.equal(t.hunt(s).name, 'sourdough starter');

  const second = t.rec(s).huntId;
  await t.navigate(s, 'https://news.ycombinator.com/', { transition: 'typed' });
  assert.notEqual(t.rec(s).huntId, second);
  assert.equal(t.hunt(s).origin, 'site');

  const third = t.rec(s).huntId;
  await t.navigate(s, 'https://news.ycombinator.com/item?id=1', { transition: 'link' });
  assert.equal(t.rec(s).huntId, third, 'following links stays in the hunt');
});

test('the side panel groups tabs by hunt, most recent first', async () => {
  const t = await setup({ settings: { laterMode: 'off' } });
  const s = await t.open(SEARCH, { transition: 'generated' });
  await t.background(s, 'https://shop.example/shoe-a');
  await t.use(1);
  await t.open('https://github.com/ste-al/ebb', { transition: 'typed' });
  await t.use(1);
  await t.open('https://mail.google.com/mail/u/0/#inbox', { transition: 'auto_bookmark' });
  const vm = await t.message({ type: 'panel:state' });
  const [w] = vm.windows;
  assert.deepEqual(w.hunts.map((h) => h.name), ['github.com', 'trail running shoes']);
  assert.equal(w.hunts[1].tabs.length, 2);
  assert.equal(w.steady.length, 1, 'web apps are listed apart, as always-open');
  assert.equal(vm.totals.live, 4);
});

test('guard mode: the fifth background tab from one page in five minutes goes to Later', async () => {
  const t = await setup();
  const src = await t.open('https://news.ycombinator.com/', { transition: 'typed' });
  const opened = [];
  for (let i = 1; i <= 4; i++) opened.push(await t.background(src, `https://blog.example/post-${i}`));
  assert.ok(opened.every((id) => t.tab(id)), 'the first four open normally');

  const fifth = await t.background(src, 'https://blog.example/post-5', { linkText: 'Post five: the tide tables' });
  assert.equal(t.tab(fifth), null, 'the fifth is closed right away');
  const [item] = await t.items('later');
  assert.equal(item.url, 'https://blog.example/post-5');
  assert.equal(item.title, 'Post five: the tide tables', 'named after the link you clicked');
  assert.equal(item.source.huntId, t.rec(src).huntId);
  assert.equal(t.browser.badge.text, '1');
  const toast = t.browser.toasts.at(-1);
  assert.equal(toast.tabId, src);
  assert.match(toast.toast.text, /Saved to Later/);

  const res = await t.toastAction(src, 'open-later', { laterId: item.id });
  assert.match(res.toast.text, /background/);
  assert.equal((await t.items('later')).length, 0);
  const reopened = t.browser.queryTabs({}).find((tab) => tab.url === 'https://blog.example/post-5');
  assert.equal(reopened.active, false);
  assert.equal(t.rec(reopened.id).huntId, t.rec(src).huntId, 'it rejoins its hunt');
  assert.equal(t.browser.badge.text, '');
});

test('the guard resets after five minutes, and always/off modes do what they say', async () => {
  const t = await setup();
  const src = await t.open('https://news.ycombinator.com/');
  for (let i = 1; i <= 4; i++) await t.background(src, `https://blog.example/a${i}`);
  await t.use(6);
  const later = await t.background(src, 'https://blog.example/a5');
  assert.ok(t.tab(later), 'a new five-minute window');

  await t.message({ type: 'panel:settings', patch: { laterMode: 'always' } });
  const queued = await t.background(src, 'https://blog.example/b1');
  assert.equal(t.tab(queued), null);

  await t.message({ type: 'panel:settings', patch: { laterMode: 'off' } });
  for (let i = 1; i <= 6; i++) await t.background(src, `https://blog.example/c${i}`);
  assert.equal((await t.items('later')).length, 1);
});

test('links you open in the foreground are never queued', async () => {
  const t = await setup({ settings: { laterMode: 'always' } });
  const src = await t.open('https://news.ycombinator.com/');
  const id = await t.open('https://blog.example/now', { opener: src, transition: 'link' });
  assert.ok(t.tab(id));
  assert.equal((await t.items('later')).length, 0);
});

test('Save link to Later and Send tab to Later', async () => {
  const t = await setup();
  const src = await t.open('https://news.ycombinator.com/');
  t.browser.tabs.get(src).page.linkText['https://blog.example/x'] = 'An essay about tides';
  await t.engine.dispatch('saveLinkToLater', 'https://blog.example/x', t.tab(src));
  await t.settle();
  const other = await t.open('https://example.com/read-me');
  await t.engine.dispatch('sendTabToLater', t.tab(other));
  await t.settle();
  assert.equal(t.tab(other), null);
  const titles = (await t.items('later')).map((i) => i.title).sort();
  assert.deepEqual(titles, ['An essay about tides', 'example.com']);
  assert.equal(t.state.counts.later, 2);
});

test('Later links unread for two weeks move to the Library', async () => {
  const t = await setup();
  await t.engine.dispatch('addLater', { url: 'https://blog.example/old', title: 'Old' });
  await t.use(1); // the daily pass runs once now
  t.browser.time += 15 * DAY;
  await t.use(1);
  assert.equal((await t.items('later')).length, 0);
  const [item] = await t.items();
  assert.equal(item.reason, 'later-expired');
  assert.equal(t.state.counts.later, 0);
});
