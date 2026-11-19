import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from '../fakes/harness.js';
import { HOUR } from '../../extension/lib/util.js';

const CONFIRM = 'https://shop.example/order/confirmation?id=42';

async function shoppingHunt(t, extra = 3) {
  t.browser.page(CONFIRM, { title: 'Order confirmed', headings: ['Thank you for your order!'], hasReference: true });
  const s = await t.open('https://www.google.com/search?q=standing+desk', { transition: 'generated' });
  const results = [];
  for (let i = 0; i < extra; i++) results.push(await t.background(s, `https://shop.example/desk-${i}`));
  return { s, results };
}

test('after an order confirmation Ebb offers to tuck the task away, and Undo brings it back', async () => {
  const t = await setup();
  const { s, results } = await shoppingHunt(t);
  const [buy, ...others] = results;
  const elsewhere = await t.open('https://example.com/unrelated', { active: false, transition: 'typed' });
  await t.activate(buy);
  await t.navigate(buy, CONFIRM, { transition: 'form_submit' });

  const offer = t.browser.toasts.find((x) => x.tabId === buy);
  assert.ok(offer, 'an offer is shown on the confirmation page');
  assert.match(offer.toast.text, /^Ordered\? Tuck away the 3 other tabs from “standing desk”/);
  assert.deepEqual(offer.toast.actions.map((a) => a.id), ['tuck', 'dismiss']);

  const res = await t.toastAction(buy, 'tuck', offer.toast.actions[0].data);
  assert.match(res.toast.text, /Tucked away 3 tabs/);
  for (const id of [s, ...others]) assert.equal(t.tab(id), null);
  assert.ok(t.tab(buy), 'the confirmation page itself stays open');
  assert.ok(t.tab(elsewhere), 'other tasks are untouched');
  const items = await t.items();
  const batchId = res.toast.actions[0].data.batchId;
  assert.equal(items.filter((i) => i.batchId === batchId && i.reason === 'mission').length, 3);
  assert.equal(items.filter((i) => i.reason === 'receipt').length, 1, 'a receipt of the confirmation is kept');
  assert.match(t.state.lastBatch.label, /Tucked away 3 tabs from “standing desk”/);

  const undo = await t.toastAction(buy, 'undo', { batchId });
  assert.match(undo.toast.text, /Brought back 3 tabs/);
  const back = t.browser.queryTabs({}).filter((tab) => tab.url.startsWith('https://shop.example/desk-') || tab.url.includes('google.com'));
  assert.equal(back.length, 3);
  assert.ok(back.every((tab) => tab.discarded && !tab.active), 'brought back unloaded, so nothing reloads at once');
  assert.ok(back.every((tab) => t.rec(tab.id).huntId === t.rec(buy).huntId), 'back in their hunt');
  assert.equal((await t.items()).length, 0, 'the batch and its receipt left the Library');
  assert.equal(t.state.lastBatch, null);
});

test('no offer for small tasks, ordinary pages, or twice within six hours', async () => {
  const t = await setup();
  t.browser.page(CONFIRM, { title: 'Order confirmed', headings: ['Thank you for your order!'], hasReference: true });
  const s = await t.open('https://www.google.com/search?q=desk+lamp', { transition: 'generated' });
  const only = await t.background(s, 'https://shop.example/lamp');
  await t.activate(only);
  await t.navigate(only, CONFIRM, { transition: 'form_submit' });
  assert.equal(t.browser.toasts.length, 0, 'one other tab is not worth an offer');

  const t2 = await setup();
  const { results } = await shoppingHunt(t2);
  await t2.activate(results[0]);
  await t2.navigate(results[0], 'https://shop.example/cart', { transition: 'link' });
  assert.equal(t2.browser.toasts.length, 0, 'a cart page is not a confirmation');
  await t2.navigate(results[0], CONFIRM, { transition: 'form_submit' });
  assert.equal(t2.browser.toasts.length, 1);
  await t2.navigate(results[0], `${CONFIRM}&again=1`, { transition: 'reload' });
  assert.equal(t2.browser.toasts.length, 1, 'not offered again for the same hunt');
  t2.browser.time += 7 * HOUR;
  await t2.navigate(results[0], `${CONFIRM}&again=2`, { transition: 'reload' });
  assert.equal(t2.browser.toasts.length, 2, 'offered again after six hours');
});

test('turning the offer off in settings silences it', async () => {
  const t = await setup({ settings: { mission: false } });
  const { results } = await shoppingHunt(t);
  await t.activate(results[0]);
  await t.navigate(results[0], CONFIRM, { transition: 'form_submit' });
  assert.equal(t.browser.toasts.length, 0);
});

test('fresh start moves unprotected tabs to the Library, and Undo brings them back unloaded', async () => {
  const t = await setup();
  const pinned = await t.open('https://example.com/pinned', { pinned: true });
  const grouped = await t.open('https://example.com/grouped');
  t.browser.groupTabs({ tabIds: [grouped] });
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(await t.open(`https://example.com/${i}`));
  const here = ids.at(-1);

  const res = await t.act('fresh-start');
  assert.equal(res.count, 4);
  assert.ok(t.tab(pinned) && t.tab(grouped) && t.tab(here), 'pinned, grouped and current tabs stay');
  assert.equal((await t.items()).filter((i) => i.reason === 'fresh-start').length, 4);

  const undo = await t.act('undo', { batchId: res.batchId });
  assert.equal(undo.count, 4);
  const urls = [0, 1, 2, 3].map((i) => `https://example.com/${i}`);
  const back = t.browser.queryTabs({}).filter((tab) => urls.includes(tab.url));
  assert.equal(back.length, 4);
  assert.ok(back.every((tab) => tab.discarded));
});

test('Done on a hunt in the panel tucks it away without a confirmation page', async () => {
  const t = await setup();
  const { s, results } = await shoppingHunt(t);
  const elsewhere = await t.open('https://example.com/elsewhere', { transition: 'typed' });
  const res = await t.act('tuck-hunt', { huntId: t.rec(s).huntId });
  assert.equal(res.count, 4);
  for (const id of [s, ...results]) assert.equal(t.tab(id), null);
  assert.ok(t.tab(elsewhere));
});

for (const action of ['fresh-start', 'tuck-hunt']) {
  test(`${action} keeps a draft first reported during the closing capture`, async () => {
    const t = await setup();
    const source = await t.open('https://example.com/story');
    const draft = await t.background(source, 'https://example.com/compose');
    const other = await t.background(source, 'https://example.com/related');
    t.browser.type(draft);

    const result = await t.act(action, { huntId: t.rec(source).huntId });
    assert.ok(t.tab(draft));
    assert.equal(t.rec(draft).dirty, true);
    assert.equal(t.tab(other), null);
    assert.equal(result.count, 1);
    assert.deepEqual((await t.items()).map((item) => item.url), ['https://example.com/related']);
  });
}
