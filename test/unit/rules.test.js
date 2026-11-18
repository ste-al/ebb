import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN, DAY } from '../../extension/lib/util.js';
import { generation, thresholds, targetStage, nextTransition, protection } from '../../extension/lib/lifetimes.js';
import { detectMission, REFERENCE_RE } from '../../extension/lib/mission.js';
import { decideLater, isExpired } from '../../extension/lib/later.js';
import { summarize, hostMultipliers, ledgerSentence } from '../../extension/lib/ledger.js';
import { decideHunt, huntLabel } from '../../extension/lib/hunts.js';

test('lifetimes: generations, pace, page kind and per-site multipliers', () => {
  assert.deepEqual([0, 1, 2, 3, 9].map(generation), [0, 0, 1, 2, 2]);
  assert.deepEqual(thresholds({ visits: 1, kind: 'other' }), { rest: 30 * MIN, shelf: 180 * MIN, archive: 1440 * MIN });
  assert.equal(thresholds({ visits: 3, kind: 'other' }).rest, 360 * MIN);
  assert.equal(thresholds({ visits: 1, kind: 'news' }).rest, 15 * MIN);
  assert.equal(thresholds({ visits: 1, kind: 'reference', pace: 'gentle' }).rest, 120 * MIN);
  assert.equal(thresholds({ visits: 1, kind: 'other', pace: 'brisk', hostMultiplier: 3 }).rest, 45 * MIN);
  assert.equal(thresholds({ visits: 1, kind: 'unknown-kind', pace: 'unknown-pace' }).rest, 30 * MIN);
});

test('lifetimes: target stage and what comes next', () => {
  const th = thresholds({ visits: 1, kind: 'other' });
  assert.equal(targetStage(29 * MIN, th), 'live');
  assert.equal(targetStage(30 * MIN, th), 'resting');
  assert.equal(targetStage(200 * MIN, th), 'shelved');
  assert.equal(targetStage(2 * DAY, th), 'archived');
  assert.deepEqual(nextTransition('live', 10 * MIN, th), { stage: 'resting', inMs: 20 * MIN });
  assert.deepEqual(nextTransition('resting', 100 * MIN, th), { stage: 'shelved', inMs: 80 * MIN });
  assert.deepEqual(nextTransition('shelved', 2000 * MIN, th), { stage: 'archived', inMs: 0 });
});

test('lifetimes: protections, in order', () => {
  const ctx = { now: 1000, paused: false, exemptHosts: ['example.org'] };
  const tab = (extra = {}) => ({ url: 'https://example.com/', active: false, pinned: false, audible: false, ...extra });
  assert.equal(protection(tab(), {}, ctx), null);
  assert.equal(protection(tab(), {}, { ...ctx, paused: true }), 'paused');
  assert.equal(protection(null, {}, ctx), 'gone');
  assert.equal(protection(tab({ active: true }), {}, ctx), 'in view');
  assert.equal(protection(tab({ pinned: true }), {}, ctx), 'pinned');
  assert.equal(protection(tab({ audible: true }), {}, ctx), 'playing');
  assert.equal(protection(tab({ autoDiscardable: false }), {}, ctx), 'kept active');
  assert.equal(protection(tab({ url: 'chrome://settings' }), {}, ctx), 'not a web page');
  assert.equal(protection(tab(), { keep: 'always' }, ctx), 'kept');
  assert.equal(protection(tab(), { keepUntil: 2000 }, ctx), 'kept for now');
  assert.equal(protection(tab(), { keepUntil: 500 }, ctx), null, 'an expired keep no longer protects');
  assert.equal(protection(tab(), { dirty: true }, ctx), 'unsaved input');
  assert.equal(protection(tab(), { kind: 'app' }, ctx), 'app');
  assert.equal(protection(tab({ url: 'https://a.example.org/' }), {}, ctx), 'exempt site');
});

test('mission: confirmation pages in several languages', () => {
  const yes = [
    { url: 'https://shop.example/checkout/success', title: 'Thank you for your order', hasReference: true },
    { url: 'https://shop.example/order/confirmation?id=1', title: 'Shop' },
    { url: 'https://airline.example/manage', title: 'Your booking is confirmed', headings: ['Booking reference ABC123'], hasReference: true },
    { url: 'https://jobs.example/apply/done', headings: ['Your application has been submitted'] },
    { url: 'https://www.alza.cz/objednavka/hotovo', headings: ['Děkujeme za vaši objednávku'], hasReference: true },
    { url: 'https://shop.example.de/kasse', headings: ['Vielen Dank für Ihre Bestellung'] },
    { url: 'https://boutique.example.fr/fin', headings: ['Merci pour votre commande'] },
    { url: 'https://tienda.example.es/fin', headings: ['¡Gracias por tu pedido!'] },
    { url: 'https://pay.example/payment/success', title: 'Payment' },
    { url: 'https://www.booking.example/confirmation.html', headings: ['Thanks, Alex! Your booking in Lisbon is confirmed.'] },
    { url: 'https://shop.example/account', headings: ['Your order #A-1234 has been placed'] },
    { url: 'https://www.amazon.example/gp/buy/thankyou/handlers/display.html', title: 'Amazon' },
    { url: 'https://events.example/e/7', headings: ['You’re registered!'] },
    { url: 'https://shop.example/x', headings: ['Order confirmation'] },
    { url: 'https://www.alza.cz/x', headings: ['Objednávka byla úspěšně odeslána'] },
    { url: 'https://hotel.example/x', headings: ['Thank you for your booking'] },
    { url: 'https://boutique.example.fr/x', headings: ['Votre commande a été enregistrée'] },
    { url: 'https://tienda.example.es/x', headings: ['Tu pedido ha sido confirmado'] },
  ];
  for (const signals of yes) assert.ok(detectMission(signals), JSON.stringify(signals));
  assert.equal(detectMission(yes[2]).kind, 'booking');
  assert.equal(detectMission(yes[3]).kind, 'application');
  assert.equal(detectMission(yes[9]).kind, 'booking');
  assert.equal(detectMission(yes[12]).kind, 'registration');
  assert.equal(detectMission(yes[15]).kind, 'booking', 'a booking thank-you is not an order');
});

test('mission: ordinary pages are not mistaken for confirmations', () => {
  const no = [
    { url: 'https://shop.example/cart', title: 'Your cart', headings: ['Order summary'] },
    { url: 'https://shop.example/product/desk', headings: ['Order now and get free shipping'] },
    { url: 'https://blog.example/how-to-track-your-order', title: 'How to find your order number', hasReference: true },
    { url: 'https://site.example/thank-you', title: 'Thanks for subscribing' },
    { url: 'not a url', title: 'Thank you for your order' },
    { url: 'https://shop.example/checkout', headings: ['Your order will be confirmed by email'] },
    { url: 'https://help.example/orders', headings: ['How to view your order confirmation'] },
    { url: 'https://shop.example/orders', headings: ['Orders placed before 2 pm ship today'] },
  ];
  for (const signals of no) assert.equal(detectMission(signals), null, JSON.stringify(signals));
});

test('mission: the reference-number pattern', () => {
  const yes = ['Order number: 123', 'Order No. 5', 'Order no 12345', 'Booking reference ABC', 'Booking ref: Q7', 'Order ID: 9', 'Confirmation #77', 'Číslo objednávky 9', 'Bestellnummer 5', 'numéro de commande 3'];
  for (const s of yes) assert.ok(REFERENCE_RE.test(s), s);
  for (const s of ['We ordered pizza', 'Order notes', 'Add a booking note', 'order identity']) assert.equal(REFERENCE_RE.test(s), false, s);
});

test('later: guard lets a few background tabs through, always and off do what they say', () => {
  let history = [];
  const at = (m) => m * MIN;
  const results = [];
  for (let i = 0; i < 6; i++) {
    const r = decideLater({ mode: 'guard', allow: 4, windowMin: 5, now: at(i * 0.5), history });
    history = r.history;
    results.push(r.queue);
  }
  assert.deepEqual(results, [false, false, false, false, true, true]);
  const later = decideLater({ mode: 'guard', allow: 4, windowMin: 5, now: at(20), history });
  assert.equal(later.queue, false, 'the window moved on');
  assert.deepEqual(later.history, [at(20)]);
  assert.equal(decideLater({ mode: 'always', now: 0, history: [] }).queue, true);
  assert.equal(decideLater({ mode: 'off', now: 0, history: Array(20).fill(0) }).queue, false);
  assert.equal(isExpired({ savedAt: 0 }, 15 * DAY, 14), true);
  assert.equal(isExpired({ savedAt: 0 }, 13 * DAY, 14), false);
  assert.equal(isExpired({ savedAt: 0 }, 99 * DAY, 0), false, '0 days means never');
});

test('ledger: what counts as tidied, the regret rate, and per-site multipliers', () => {
  const e = (type, extra = {}) => ({ type, at: 100, host: 'a.example', ...extra });
  const events = [
    e('rest'),
    e('shelve'),
    e('shelve'),
    e('archive', { from: 'shelved' }), // already counted when shelved
    e('archive', { from: 'live' }),
    e('tuck', { from: 'resting' }),
    e('later'),
    e('restore', { from: 'shelf' }),
    e('open-later'),
    e('shelve', { at: 1 }), // before the window
  ];
  const s = summarize(events, { since: 50 });
  assert.deepEqual(
    { tidied: s.tidied, restored: s.restored, rested: s.rested, archived: s.archived, tucked: s.tucked, queued: s.queued },
    { tidied: 5, restored: 1, rested: 1, archived: 2, tucked: 1, queued: 1 },
  );
  assert.equal(s.rate, 0.2);
  assert.equal(ledgerSentence(s), 'Ebb tidied 5 tabs and you brought back 1 (20%). Nothing was deleted.');
  assert.match(ledgerSentence(summarize([])), /Nothing tidied yet/);

  const often = [...Array(5)].map(() => e('shelve', { host: 'b.example' })).concat([...Array(3)].map(() => e('restore', { host: 'b.example' })));
  const some = [...Array(10)].map(() => e('shelve', { host: 'c.example' })).concat([...Array(3)].map(() => e('restore', { host: 'c.example' })));
  const few = [e('shelve', { host: 'd.example' }), e('restore', { host: 'd.example' }), e('restore', { host: 'd.example' })];
  assert.deepEqual(hostMultipliers([...often, ...some, ...few]), { 'b.example': 3, 'c.example': 2 });
});

test('hunts: what a navigation does to the current hunt', () => {
  const search = (query) => ({ engine: 'Google', query });
  const site = { origin: 'site', host: 'example.com', name: 'example.com', queries: [] };
  const hunt = { origin: 'search', queries: ['trail running shoes'] };
  assert.equal(decideHunt({ current: null, url: 'https://example.com/', transition: 'typed', search: null }).action, 'new');
  assert.deepEqual(decideHunt({ current: hunt, url: 'https://g/', transition: 'form_submit', search: search('trail running shoes men') }), {
    action: 'keep',
    addQuery: 'trail running shoes men',
  });
  assert.equal(decideHunt({ current: hunt, url: 'https://g/', transition: 'link', search: search('running gear') }).action, 'new');
  assert.equal(decideHunt({ current: hunt, url: 'https://g/', transition: 'link', search: search('running gear'), refining: true }).action, 'keep');
  assert.equal(decideHunt({ current: hunt, url: 'https://shop.example/', transition: 'link', search: null }).action, 'keep');
  assert.equal(decideHunt({ current: site, url: 'https://example.com/other', transition: 'typed', search: null }).action, 'keep');
  assert.equal(decideHunt({ current: site, url: 'https://other.example/', transition: 'auto_bookmark', search: null }).action, 'new');
  assert.equal(huntLabel({ origin: 'search', queries: ['a', 'b'] }), 'b');
  assert.equal(huntLabel(site), 'example.com');
  assert.equal(huntLabel(null), 'Loose tabs');
});
