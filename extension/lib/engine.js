// The Ebb engine. All behavior lives here; browser access goes through `ports`
// (chrome-ports.js has the real ones, test/fakes/fake-browser.js the test doubles).
//
// Handlers run through dispatch(), which serializes work, loads state on demand
// (the MV3 service worker can be stopped at any time) and saves it afterwards.
// Talking to pages (which can be slow) happens outside the queue where possible.

import { MIN, HOUR, DAY, hostOf, isWebUrl, normalizeUrl, prettyUrl } from './util.js';
import { parseSearch } from './search.js';
import { classify } from './classify.js';
import { thresholds, targetStage, nextTransition, protection, STAGE_RANK } from './lifetimes.js';
import { detectMission, MISSION_WORDS, REFERENCE_RE } from './mission.js';
import { decideLater, isExpired } from './later.js';
import { summarize, hostMultipliers, ledgerSentence, LEDGER_RETENTION_MS } from './ledger.js';
import { decideHunt, huntLabel } from './hunts.js';
import { withDefaults } from './settings.js';

export const TICK_MINUTES = 1;
export const ADOPT_MS = 2 * MIN; // after a browser start, restored tabs are matched to their old records
export const LIMBO_MS = 5 * MIN; // tabs of a closed window wait this long in case it is reopened
export const REVISIT_GAP = 2 * MIN; // active time away from a tab before coming back counts as a revisit
export const BUDGET_MIN_IDLE = 20 * MIN; // the soft budget never shelves a tab used more recently than this
export const INSTALL_GRACE = 60 * MIN; // active time after install before the soft budget starts
export const MIN_SHELF_STAY = 60 * MIN; // active time on the Shelf before a tab may move on to the Library
export const REST_RETRY = 30 * MIN; // after a failed unload, wait this much active time before trying again
export const MAX_MOVES_PER_PASS = 25; // shelve or archive at most this many tabs per pass
const MAX_RESTS_PER_PASS = 40;
const CAPTURE_TIMEOUT = 700;
const SIGNALS_DELAY = 1200; // let confirmation pages finish rendering before reading them
const OFFER_COOLDOWN = 6 * HOUR;
const BATCH_VISIBLE_MS = 30 * MIN;
export const SHELF_TITLE = 'Shelf';
const SHELF_TITLE_RE = /^Shelf( · \d+)?$/;

export function emptyState() {
  return {
    version: 1,
    installedClock: 0,
    clock: { activeMs: 0, lastTickAt: null, focused: true, idle: 'active' },
    tabs: {}, // tabId -> record
    hunts: {}, // huntId -> hunt
    shelf: {}, // windowId -> id of that window's Shelf group
    activeByWindow: {}, // windowId -> active tabId
    spawns: {}, // source tabId -> times it opened background tabs (Later lane guard)
    pendingRestore: {}, // tabId -> { freeze, url }: scroll/media state to apply when that page loads
    pendingDiscard: {}, // tabId -> true: unload as soon as the page has its URL (undo of a batch)
    limbo: {}, // normalized URL -> [{ rec, at }] from windows that were closed
    startup: null,
    resume: null,
    lastBatch: null,
    hostMult: {},
    hostMultAt: 0,
    lastDaily: 0,
    counts: { later: 0 },
  };
}

function migrate(stored) {
  const base = emptyState();
  if (!stored || typeof stored !== 'object' || stored.version !== 1) return base;
  return { ...base, ...stored, clock: { ...base.clock, ...stored.clock }, counts: { ...base.counts, ...stored.counts } };
}

const isShelfTitle = (title) => SHELF_TITLE_RE.test(String(title || ''));
const finite = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export class Engine {
  constructor(ports) {
    this.p = ports;
    this.state = null;
    this.settings = null;
    this.loading = null;
    this.queue = Promise.resolve();
    this.pending = new Set();
    this.changed = false;
    this.persistTimer = null;
    this.flushDelay = ports.flushDelayMs ?? 400;
    this.lastBadge = null;
    this.expectedRemovals = new Set();
  }

  // ---------------------------------------------------------------- plumbing

  enqueue(fn) {
    const result = this.queue.then(fn, fn);
    this.queue = result.catch(() => {});
    return result;
  }

  /** Run a handler serially, with state loaded before and saved after. */
  dispatch(method, ...args) {
    return this.enqueue(async () => {
      await this.load();
      try {
        return await this[method](...args);
      } finally {
        await this.flush();
      }
    });
  }

  /** Work that talks to pages runs here, outside the queue. */
  spawn(fn) {
    const task = Promise.resolve()
      .then(fn)
      .catch((err) => this.p.warn?.('Ebb: background task failed', err))
      .finally(() => this.pending.delete(task));
    this.pending.add(task);
    return task;
  }

  /** Resolves once the queue and all spawned work are done (used by tests). */
  async idle() {
    for (;;) {
      const q = this.queue;
      await q;
      if (this.pending.size) {
        await Promise.allSettled([...this.pending]);
        continue;
      }
      if (q === this.queue) return;
    }
  }

  async load() {
    if (this.state) return;
    this.loading ||= (async () => {
      const got = (await this.p.storage.get(['ebb:state', 'ebb:settings'])) || {};
      this.settings = withDefaults(got['ebb:settings']);
      this.state = migrate(got['ebb:state']);
      await this.checkSession();
    })().finally(() => {
      this.loading = null;
    });
    await this.loading;
  }

  touch() {
    this.changed = true;
  }

  async flush() {
    if (!this.changed) return;
    this.changed = false;
    if (this.flushDelay <= 0) {
      await this.persist();
      return;
    }
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.enqueue(() => this.persist()).catch((err) => this.p.warn?.('Ebb: saving failed', err));
    }, this.flushDelay);
  }

  async persist() {
    if (!this.state) return;
    await this.p.storage.set({ 'ebb:state': this.state, 'ebb:settings': this.settings });
    this.p.notify?.({ type: 'ebb:changed' });
    await this.updateBadge();
  }

  async updateBadge() {
    const n = this.state.counts.later || 0;
    const text = this.state.resume ? '↺' : n > 0 ? String(Math.min(n, 999)) : '';
    if (text === this.lastBadge) return;
    this.lastBadge = text;
    await this.p.action?.setBadge(text, '#0f766e');
  }

  now() {
    return this.p.now();
  }

  get activeMs() {
    return this.state.clock.activeMs;
  }

  ctx(overrides = {}) {
    return { now: this.now(), paused: this.settings.paused, exemptHosts: this.settings.exemptHosts, ...overrides };
  }

  async log(event) {
    await this.p.repo.put('ledger', { id: this.p.id('ev'), at: this.now(), ...event });
  }

  toast(tabId, toast) {
    this.spawn(() => this.p.tabs.sendMessage(tabId, { type: 'ebb:toast', toast }, 1000));
  }

  /** New tabs go just before the window's Shelf, so the Shelf stays at the end of the tab bar. */
  async placeNewTab(props, windowId) {
    const target = windowId ?? (await this.p.windows.getLastFocused())?.id;
    if (target == null) return props;
    const groupId = this.state.shelf[target];
    const shelved = groupId == null ? [] : await this.p.tabs.query({ groupId });
    return shelved.length ? { ...props, windowId: target, index: Math.min(...shelved.map((t) => t.index)) } : { ...props, windowId: target };
  }

  async createTab(props) {
    let tab = await this.p.tabs.create(props);
    if (!tab && props.windowId != null) {
      const { url, active } = props;
      tab = await this.p.tabs.create({ url, active });
    }
    return tab || null;
  }

  // ---------------------------------------------------------------- browser sessions

  /**
   * chrome.storage.session is empty after a browser restart, and also after Ebb itself was
   * reloaded, updated or re-enabled. Tab ids only change in the first case, so check whether
   * the tabs Ebb knew about are still there.
   */
  async checkSession() {
    if (!this.p.session) return;
    if (await this.p.session.get()) return;
    await this.p.session.set();
    const known = Object.values(this.state.tabs).filter((r) => isWebUrl(r.url));
    if (!known.length) return;
    const tabs = await this.p.tabs.query({ windowType: 'normal' });
    const byId = new Map(tabs.map((t) => [t.id, t]));
    const missing = known.filter((r) => {
      const t = byId.get(r.tabId);
      return !t || normalizeUrl(t.url || t.pendingUrl || '') !== normalizeUrl(r.url);
    }).length;
    if (missing > known.length / 2) await this.startup();
    else this.reconcile(tabs);
  }

  /** Forget tabs that no longer exist and pick up ones Ebb has not seen. */
  reconcile(tabs) {
    const ids = new Set(tabs.map((t) => t.id));
    for (const id of Object.keys(this.state.tabs)) {
      if (!ids.has(Number(id))) delete this.state.tabs[id];
    }
    for (const t of tabs) {
      this.ensureRecord(t);
      if (t.active) this.state.activeByWindow[t.windowId] = t.id;
    }
    this.touch();
  }

  // ---------------------------------------------------------------- active clock

  /** Count time only while Chrome is focused and you are at the keyboard. */
  accrue() {
    const now = this.now();
    const c = this.state.clock;
    if (c.lastTickAt != null && c.focused && c.idle === 'active') {
      c.activeMs += Math.min(Math.max(0, now - c.lastTickAt), 2 * MIN);
    }
    c.lastTickAt = now;
    this.touch();
  }

  /** A natural boundary: you stepped away or switched to another app. */
  atBoundary() {
    const c = this.state.clock;
    return !c.focused || c.idle !== 'active';
  }

  // ---------------------------------------------------------------- records & hunts

  newRecord(tab) {
    const url = tab.url || tab.pendingUrl || '';
    const now = this.now();
    const shelved = this.shelfGroupIds().has(tab.groupId);
    return {
      tabId: tab.id,
      windowId: tab.windowId,
      url: isWebUrl(url) ? url : '',
      title: tab.title || '',
      favIconUrl: tab.favIconUrl || '',
      kind: classify(url),
      huntId: null,
      opener: tab.openerTabId ?? null,
      createdAt: now,
      lastActiveClock: this.activeMs,
      lastActiveAt: now,
      lastSearchClock: null,
      visits: tab.active ? 1 : 0,
      stage: shelved ? 'shelved' : tab.discarded ? 'resting' : 'live',
      shelvedClock: shelved ? this.activeMs : null,
      keep: null,
      keepUntil: 0,
      dirty: false,
      freeze: null,
      excerpt: '',
      excerptUrl: '',
      description: '',
      signalsUrl: '',
      restFailedClock: null,
      fresh: true,
    };
  }

  /** The record for a tab, created (or adopted from a previous session) when missing. */
  ensureRecord(tab) {
    let rec = this.state.tabs[tab.id];
    if (!rec) {
      rec = this.adopt(tab) || this.newRecord(tab);
      this.state.tabs[tab.id] = rec;
      this.touch();
    }
    if (tab.windowId != null) rec.windowId = tab.windowId;
    const url = tab.url || tab.pendingUrl;
    if (url && url !== rec.url && isWebUrl(url)) {
      rec.url = url;
      rec.kind = classify(url);
    }
    if (tab.title) rec.title = tab.title;
    if (tab.favIconUrl) rec.favIconUrl = tab.favIconUrl;
    return rec;
  }

  /** Match a tab to a record from the previous session or from a just-closed window. */
  adopt(tab) {
    const key = normalizeUrl(tab.url || tab.pendingUrl || '');
    if (!isWebUrl(key)) return null;
    const startup = this.state.startup;
    let old = null;
    if (startup && this.now() < startup.adoptUntil && startup.prev[key]?.length) {
      old = startup.prev[key].shift();
      if (!startup.prev[key].length) delete startup.prev[key];
      const huntKey = old.huntId || '_';
      startup.adoptedHunts[huntKey] = (startup.adoptedHunts[huntKey] || 0) + 1;
    } else if (this.state.limbo[key]?.length) {
      old = this.state.limbo[key].shift().rec;
      if (!this.state.limbo[key].length) delete this.state.limbo[key];
    }
    if (!old) return null;
    const stage = this.shelfGroupIds().has(tab.groupId) ? 'shelved' : tab.discarded ? 'resting' : 'live';
    return { ...old, tabId: tab.id, windowId: tab.windowId, stage, wasStage: old.stage, fresh: false, adopted: true, keepHuntOnce: true };
  }

  /** A restored tab may only get its URL after it was created: adopt it then. */
  lateAdopt(tab, rec) {
    if (!rec.fresh || !this.state.startup) return rec;
    const adopted = this.adopt(tab);
    if (!adopted) return rec;
    this.state.tabs[tab.id] = adopted;
    this.touch();
    return adopted;
  }

  /** Resume, don't restore: tabs that were unloaded before a restart stay unloaded. */
  async settleAdopted(tab, rec) {
    const was = rec.wasStage;
    if (!was) return;
    delete rec.wasStage;
    this.touch();
    if ((was === 'resting' || was === 'shelved') && !tab.active && !tab.discarded) {
      const d = await this.p.tabs.discard(tab.id);
      if (d) {
        if (d.id !== tab.id) this.replaceTabId(tab.id, d.id);
        if (rec.stage === 'live') rec.stage = 'resting';
      }
    }
  }

  createHunt(fields) {
    const now = this.now();
    const hunt = {
      id: this.p.id('hunt'),
      origin: 'site',
      name: '',
      engine: null,
      queries: [],
      host: '',
      createdAt: now,
      lastActiveAt: now,
      lastActiveClock: this.activeMs,
      offeredAt: 0,
      doneAt: 0,
      ...fields,
    };
    this.state.hunts[hunt.id] = hunt;
    this.touch();
    return hunt;
  }

  markActive(rec) {
    rec.lastActiveClock = this.activeMs;
    rec.lastActiveAt = this.now();
    const hunt = rec.huntId && this.state.hunts[rec.huntId];
    if (hunt) {
      hunt.lastActiveAt = rec.lastActiveAt;
      hunt.lastActiveClock = rec.lastActiveClock;
    }
    this.touch();
  }

  thresholdsFor(rec) {
    return thresholds({
      visits: rec.visits,
      kind: rec.kind,
      pace: this.settings.pace,
      hostMultiplier: this.state.hostMult[hostOf(rec.url)] || 1,
    });
  }

  shelfGroupIds() {
    return new Set(Object.values(this.state.shelf).map(Number));
  }

  /** Tabs in your own tab groups are only ever unloaded, never moved. */
  heldByGroup(tab, shelfIds = this.shelfGroupIds()) {
    return this.settings.respectGroups && tab.groupId != null && tab.groupId !== -1 && !shelfIds.has(tab.groupId);
  }

  async discoverShelves() {
    const groups = await this.p.groups.query({});
    for (const g of groups) if (isShelfTitle(g.title)) this.state.shelf[g.windowId] = g.id;
  }

  // ---------------------------------------------------------------- install & startup

  async install(reason) {
    if (reason === 'install') {
      this.state = emptyState();
      this.settings = withDefaults({});
    }
    this.state.clock.lastTickAt = this.now();
    if (reason === 'install') this.state.installedClock = this.activeMs;
    await this.discoverShelves();
    const tabs = await this.p.tabs.query({ windowType: 'normal' });
    this.reconcile(tabs);
    if (!this.state.startup) for (const t of tabs) this.state.tabs[t.id].fresh = false;
    return { webTabIds: tabs.filter((t) => isWebUrl(t.url) && !t.discarded).map((t) => t.id) };
  }

  /** Browser start: tab ids changed, so keep the old records by URL and adopt restored tabs. */
  async startup() {
    const now = this.now();
    if (this.state.startup && now < this.state.startup.adoptUntil) return;
    const prev = {};
    const keep = (rec) => {
      if (isWebUrl(rec.url)) (prev[normalizeUrl(rec.url)] ||= []).push(rec);
    };
    for (const rec of Object.values(this.state.tabs)) keep(rec);
    for (const list of Object.values(this.state.limbo)) for (const entry of list) keep(entry.rec);
    Object.assign(this.state, {
      tabs: {},
      shelf: {},
      activeByWindow: {},
      spawns: {},
      pendingRestore: {},
      pendingDiscard: {},
      limbo: {},
      resume: null,
      startup: { at: now, adoptUntil: now + ADOPT_MS, prev, adoptedHunts: {}, batchId: this.p.id('batch'), dismissed: false },
    });
    this.state.clock = { ...this.state.clock, lastTickAt: now, focused: true, idle: 'active' };
    await this.discoverShelves();
    const tabs = await this.p.tabs.query({ windowType: 'normal' });
    for (const t of tabs) {
      const rec = this.ensureRecord(t);
      if (t.active) this.state.activeByWindow[t.windowId] = t.id;
      await this.settleAdopted(t, rec);
    }
    this.buildResume(this.state.startup);
    this.touch();
  }

  /** After the adoption window: tabs that did not come back go to the Library. */
  async finishStartup() {
    const startup = this.state.startup;
    if (!startup) return;
    this.state.startup = null;
    for (const rec of Object.values(this.state.tabs)) rec.fresh = false;
    const closedByHunt = {};
    for (const list of Object.values(startup.prev)) {
      for (const rec of list) {
        await this.p.repo.put('library', this.libraryItem(rec, { reason: 'session-end', batchId: startup.batchId }));
        const key = rec.huntId || '_';
        closedByHunt[key] = (closedByHunt[key] || 0) + 1;
      }
    }
    this.buildResume(startup, closedByHunt);
    this.touch();
  }

  /** The resume card: what you were in the middle of, one click to focus on one thing. */
  buildResume(startup, closedByHunt = {}) {
    if (!startup || startup.dismissed) return;
    const ids = new Set([...Object.keys(startup.adoptedHunts), ...Object.keys(closedByHunt)]);
    ids.delete('_');
    const hunts = [...ids]
      .map((id) => this.state.hunts[id])
      .filter(Boolean)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      .slice(0, 6)
      .map((h) => ({ huntId: h.id, name: huntLabel(h), open: startup.adoptedHunts[h.id] || 0, closed: closedByHunt[h.id] || 0 }));
    const worth = hunts.length >= 2 || hunts.some((h) => h.closed > 0);
    this.state.resume = worth ? { at: startup.at, batchId: startup.batchId, hunts } : null;
  }

  // ---------------------------------------------------------------- ticks & boundaries

  async tick() {
    this.accrue();
    const now = this.now();
    if (this.state.startup && now >= this.state.startup.adoptUntil) await this.finishStartup();
    await this.settleLimbo(now);
    const boundary = this.atBoundary();
    await this.lifecycle({ boundary });
    if (boundary) await this.maintainShelves();
    await this.daily(now);
  }

  async onIdle(idleState) {
    this.accrue();
    this.state.clock.idle = idleState;
    if (idleState !== 'active') {
      await this.lifecycle({ boundary: true });
      await this.maintainShelves();
    }
  }

  /**
   * Window focus moved. Leaving Chrome is a boundary, but focus can drop for a moment while
   * switching between Chrome windows, so the next tick acts on it rather than this event.
   */
  async onFocus(windowId) {
    this.accrue();
    this.state.clock.focused = windowId !== -1;
    if (windowId !== -1) this.state.clock.idle = 'active';
  }

  /**
   * One pass over all tabs. Unloading (rest) can happen any time: the tab stays where it is.
   * Moving tabs to the Shelf or the Library only happens at a natural boundary.
   */
  async lifecycle({ boundary }) {
    if (this.settings.paused) return;
    if (this.state.startup && this.now() < this.state.startup.adoptUntil) return;
    const tabs = await this.p.tabs.query({ windowType: 'normal' });
    const ctx = this.ctx();
    const shelfIds = this.shelfGroupIds();
    let moves = MAX_MOVES_PER_PASS;
    let rests = MAX_RESTS_PER_PASS;

    for (let tab of tabs) {
      const rec = this.ensureRecord(tab);
      if (rec.stage === 'shelved' && !shelfIds.has(tab.groupId)) rec.stage = tab.discarded ? 'resting' : 'live';
      if (tab.active) {
        // Still in view in its window: its idle time starts when you leave it.
        rec.lastActiveClock = this.activeMs;
        continue;
      }
      if (protection(tab, rec, ctx)) continue;
      const age = this.activeMs - rec.lastActiveClock;
      let target = targetStage(age, this.thresholdsFor(rec));
      if (this.heldByGroup(tab, shelfIds) && STAGE_RANK[target] > STAGE_RANK.resting) target = 'resting';
      if (target === 'live') continue;

      if (!tab.discarded) {
        const retryOk = rec.restFailedClock == null || this.activeMs - rec.restFailedClock >= REST_RETRY;
        if (rests > 0 && retryOk) {
          rests -= 1;
          const rested = await this.rest(tab, rec);
          if (rested) tab = rested;
        }
      } else if (rec.stage === 'live') {
        rec.stage = 'resting';
        this.touch();
      }
      if (!boundary || moves <= 0 || target === 'resting') continue;

      if (rec.stage !== 'shelved') {
        if (this.settings.useShelf) {
          if (await this.shelve(tab, rec, 'idle')) moves -= 1;
        } else if (target === 'archived') {
          await this.archiveTab(tab, rec, { reason: 'idle' });
          moves -= 1;
        }
      } else if (target === 'archived' && this.activeMs - (rec.shelvedClock ?? 0) >= MIN_SHELF_STAY) {
        await this.archiveTab(tab, rec, { reason: 'idle' });
        moves -= 1;
      }
    }
    if (boundary && moves > 0) await this.applyBudget(moves);
  }

  /** Soft budget: when a window shows more tabs than the budget, shelve the longest-idle ones. */
  async applyBudget(maxMoves) {
    const limit = this.settings.budget;
    if (!limit || !this.settings.useShelf || maxMoves <= 0) return;
    if (this.activeMs - this.state.installedClock < INSTALL_GRACE) return;
    const tabs = await this.p.tabs.query({ windowType: 'normal' });
    const ctx = this.ctx();
    const shelfIds = this.shelfGroupIds();
    const byWindow = new Map();
    for (const t of tabs) {
      if (!byWindow.has(t.windowId)) byWindow.set(t.windowId, []);
      byWindow.get(t.windowId).push(t);
    }
    for (const list of byWindow.values()) {
      const visible = list.filter((t) => !t.pinned && !shelfIds.has(t.groupId));
      let excess = visible.length - limit;
      if (excess <= 0) continue;
      const candidates = visible
        .map((t) => ({ t, rec: this.ensureRecord(t) }))
        .filter(({ t, rec }) => {
          if (protection(t, rec, ctx) || this.heldByGroup(t, shelfIds)) return false;
          return this.activeMs - rec.lastActiveClock >= BUDGET_MIN_IDLE;
        })
        .sort((a, b) => a.rec.lastActiveClock - b.rec.lastActiveClock);
      for (const { t, rec } of candidates) {
        if (excess <= 0 || maxMoves <= 0) break;
        if (await this.shelve(t, rec, 'budget')) {
          excess -= 1;
          maxMoves -= 1;
        }
      }
    }
  }

  // ---------------------------------------------------------------- page state

  /**
   * Ask the page for its scroll position, media time and (once per URL) a short excerpt.
   * Skipped when the state was already captured after you last used the tab.
   */
  async captureInto(tab, rec, timeout = CAPTURE_TIMEOUT) {
    if (!tab || tab.discarded || !isWebUrl(tab.url)) return false;
    const wantText = this.settings.captureText && rec.excerptUrl !== tab.url;
    if (!wantText && rec.freeze && rec.freeze.at >= rec.lastActiveAt) return true;
    const res = await this.p.tabs.sendMessage(tab.id, { type: 'ebb:capture', text: wantText }, timeout);
    if (!res || typeof res !== 'object') return false;
    this.applyCaptureResult(rec, res, tab.url, wantText);
    return true;
  }

  applyCaptureResult(rec, res, url, withText) {
    rec.freeze = {
      scrollY: finite(res.scrollY),
      scrollRatio: Math.min(1, Math.max(0, finite(res.scrollRatio))),
      media: Array.isArray(res.media)
        ? res.media.slice(0, 3).map((m) => ({ currentTime: finite(m?.currentTime), duration: finite(m?.duration), paused: Boolean(m?.paused) }))
        : [],
      at: this.now(),
    };
    if (typeof res.title === 'string' && res.title) rec.title = res.title.slice(0, 300);
    if (typeof res.dirty === 'boolean') rec.dirty = res.dirty;
    if (withText && this.settings.captureText && typeof res.excerpt === 'string') {
      rec.excerpt = res.excerpt.slice(0, 700);
      rec.description = typeof res.description === 'string' ? res.description.slice(0, 300) : '';
      rec.excerptUrl = url;
    }
    this.touch();
  }

  /** Outside the queue: capture a tab you just left, so tidying it later needs no round trip. */
  async refreshCapture(tabId) {
    const req = await this.dispatch('captureRequest', tabId);
    if (!req) return;
    const res = await this.p.tabs.sendMessage(tabId, { type: 'ebb:capture', text: req.text }, 1000);
    if (res && typeof res === 'object') await this.dispatch('applyCapture', tabId, res, req);
  }

  async captureRequest(tabId) {
    const rec = this.state.tabs[tabId];
    if (!rec) return null;
    const tab = await this.p.tabs.get(tabId);
    if (!tab || tab.discarded || !isWebUrl(tab.url)) return null;
    return { url: tab.url, text: this.settings.captureText && rec.excerptUrl !== tab.url };
  }

  async applyCapture(tabId, res, req) {
    const rec = this.state.tabs[tabId];
    if (!rec || normalizeUrl(rec.url) !== normalizeUrl(req.url)) return;
    this.applyCaptureResult(rec, res, req.url, req.text);
  }

  // ---------------------------------------------------------------- actions on tabs

  /** Unload a tab in place. It stays where it is and reloads when clicked. */
  async rest(tab, rec) {
    await this.captureInto(tab, rec);
    if (rec.dirty) return null; // the page just told us it has unsaved input
    const result = await this.p.tabs.discard(tab.id);
    if (!result) {
      rec.restFailedClock = this.activeMs;
      this.touch();
      return null;
    }
    if (result.id !== tab.id) this.replaceTabId(tab.id, result.id);
    rec.restFailedClock = null;
    if (rec.stage === 'live') rec.stage = 'resting';
    this.touch();
    await this.log({ type: 'rest', host: hostOf(rec.url) });
    return result;
  }

  /** Move a tab into the window's collapsed Shelf group, one click away. */
  async shelve(tab, rec, reason) {
    if (!tab.discarded && !tab.active) {
      const rested = await this.rest(tab, rec);
      if (rested) tab = rested;
      else if (rec.dirty) return false;
    }
    const groupId = await this.addToShelf(tab.windowId, tab.id);
    if (groupId == null) return false;
    rec.stage = 'shelved';
    rec.shelvedAt = this.now();
    rec.shelvedClock = this.activeMs;
    this.touch();
    await this.log({ type: 'shelve', host: hostOf(rec.url), reason });
    return true;
  }

  async addToShelf(windowId, tabId) {
    let groupId = this.state.shelf[windowId];
    if (groupId != null) {
      const g = await this.p.groups.get(groupId);
      if (!g || g.windowId !== windowId) groupId = null;
    }
    try {
      if (groupId == null) {
        groupId = await this.p.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
        this.state.shelf[windowId] = groupId;
        await this.p.groups.update(groupId, { title: `${SHELF_TITLE} · 1`, color: 'grey', collapsed: true });
        await this.p.groups.move(groupId, { index: -1 });
      } else {
        await this.p.tabs.group({ tabIds: [tabId], groupId });
        const count = (await this.p.tabs.query({ groupId })).length;
        await this.p.groups.update(groupId, { title: `${SHELF_TITLE} · ${count}`, collapsed: true });
      }
    } catch {
      return null;
    }
    this.touch();
    return groupId;
  }

  libraryItem(rec, { reason, batchId = null }) {
    const hunt = rec.huntId ? this.state.hunts[rec.huntId] : null;
    return {
      id: this.p.id('lib'),
      url: rec.url,
      title: rec.title || prettyUrl(rec.url),
      favIconUrl: rec.favIconUrl || '',
      kind: rec.kind,
      huntId: rec.huntId || null,
      huntName: hunt ? huntLabel(hunt) : '',
      reason,
      batchId,
      archivedAt: this.now(),
      freeze: rec.freeze || null,
      excerpt: rec.excerpt || '',
      description: rec.description || '',
      visits: rec.visits || 0,
      fromStage: rec.stage,
    };
  }

  /** Close a tab into the Library, keeping where you were and a text excerpt. */
  async archiveTab(tab, rec, { reason, batchId = null, type = 'archive', capture = true } = {}) {
    if (capture && tab && tab.status === 'complete') await this.captureInto(tab, rec, 400);
    const item = this.libraryItem(rec, { reason, batchId });
    await this.p.repo.put('library', item);
    if (tab) {
      this.expectedRemovals.add(tab.id);
      await this.p.tabs.remove(tab.id);
    }
    delete this.state.tabs[rec.tabId];
    delete this.state.pendingRestore[rec.tabId];
    delete this.state.pendingDiscard[rec.tabId];
    this.touch();
    await this.log({ type, from: rec.stage, host: hostOf(rec.url), reason });
    return item;
  }

  /** Put your place on the page back when this tab next finishes loading the same page. */
  queueRestore(tabId, freeze, url) {
    if (!freeze || !isWebUrl(url)) return;
    this.state.pendingRestore[tabId] = { freeze, url };
    this.touch();
  }

  replaceTabId(oldId, newId) {
    const rec = this.state.tabs[oldId];
    if (!rec || oldId === newId) return;
    delete this.state.tabs[oldId];
    rec.tabId = newId;
    this.state.tabs[newId] = rec;
    for (const map of [this.state.pendingRestore, this.state.pendingDiscard]) {
      if (oldId in map) {
        map[newId] = map[oldId];
        delete map[oldId];
      }
    }
    for (const [w, id] of Object.entries(this.state.activeByWindow)) if (id === oldId) this.state.activeByWindow[w] = newId;
    this.touch();
  }

  /** Where a tab coming off the Shelf goes: after its hunt, else just before the Shelf. */
  async restoreIndex(tab, huntId) {
    const tabs = await this.p.tabs.query({ windowId: tab.windowId });
    const shelfIds = this.shelfGroupIds();
    const self = tabs.find((t) => t.id === tab.id);
    const others = tabs.filter((t) => t.id !== tab.id);
    const mates = others.filter((t) => huntId && !shelfIds.has(t.groupId) && this.state.tabs[t.id]?.huntId === huntId);
    let index;
    if (mates.length) {
      index = Math.max(...mates.map((t) => t.index)) + 1;
    } else {
      const shelved = others.filter((t) => shelfIds.has(t.groupId));
      if (!shelved.length) return null;
      index = Math.min(...shelved.map((t) => t.index));
    }
    if (self && self.index < index) index -= 1;
    return self && self.index === index ? null : index;
  }

  async restoreFromShelf(tabId, { activate = true } = {}) {
    const rec = this.state.tabs[tabId];
    const tab = await this.p.tabs.get(tabId);
    if (!rec || !tab) return false;
    rec.stage = tab.discarded && !activate && !tab.active ? 'resting' : 'live';
    await this.p.tabs.ungroup([tabId]);
    const index = await this.restoreIndex(tab, rec.huntId);
    if (index != null) await this.p.tabs.move(tabId, { index });
    if (activate) await this.p.tabs.update(tabId, { active: true });
    rec.visits += 1;
    this.queueRestore(tabId, rec.freeze, rec.url);
    this.markActive(rec);
    await this.log({ type: 'restore', from: 'shelf', host: hostOf(rec.url) });
    await this.refreshHostMult();
    return true;
  }

  /** Bring a Library item back. Recently closed tabs come back with their history. */
  async restoreItem(id, { active = true, background = false, from = 'library', windowId } = {}) {
    const item = await this.p.repo.get('library', id);
    if (!item || !isWebUrl(item.url)) return null;
    let tab = background ? null : await this.sessionRestore(item);
    if (!tab) tab = await this.createTab(await this.placeNewTab({ url: item.url, active: active && !background }, windowId));
    if (!tab) return null;
    const rec = this.ensureRecord(tab);
    if (item.huntId && !this.state.hunts[item.huntId]) {
      this.state.hunts[item.huntId] = {
        id: item.huntId,
        origin: 'restored',
        name: item.huntName || hostOf(item.url),
        engine: null,
        queries: [],
        host: hostOf(item.url),
        createdAt: this.now(),
        lastActiveAt: this.now(),
        lastActiveClock: this.activeMs,
        offeredAt: 0,
        doneAt: 0,
      };
    }
    Object.assign(rec, {
      huntId: item.huntId || rec.huntId,
      title: rec.title || item.title,
      freeze: item.freeze,
      excerpt: item.excerpt || '',
      excerptUrl: item.excerpt ? item.url : '',
      description: item.description || '',
      visits: Math.max(item.visits || 0, 1) + (background ? 0 : 1),
      fresh: false,
      restored: true,
      keepHuntOnce: true,
    });
    this.markActive(rec);
    if (background) {
      rec.stage = 'resting';
      this.state.pendingDiscard[tab.id] = true;
    }
    this.queueRestore(tab.id, item.freeze, item.url);
    await this.p.repo.delete('library', id);
    await this.log({ type: 'restore', from, host: hostOf(item.url) });
    await this.refreshHostMult();
    this.touch();
    return tab;
  }

  async sessionRestore(item) {
    if (!this.p.sessions || this.now() - item.archivedAt > 6 * HOUR) return null;
    try {
      const sessions = await this.p.sessions.getRecentlyClosed({ maxResults: 25 });
      const want = normalizeUrl(item.url);
      const hit = sessions.find((s) => s.tab && normalizeUrl(s.tab.url) === want);
      if (!hit) return null;
      const restored = await this.p.sessions.restore(hit.tab.sessionId);
      return restored?.tab || null;
    } catch {
      return null;
    }
  }

  /** Undo restores open tabs in the background; unload each as soon as it has its URL. */
  async discardPending(tab) {
    if (tab.active || tab.discarded) {
      delete this.state.pendingDiscard[tab.id];
      this.touch();
      return;
    }
    if (!isWebUrl(tab.url)) return;
    delete this.state.pendingDiscard[tab.id];
    const d = await this.p.tabs.discard(tab.id);
    if (d && d.id !== tab.id) this.replaceTabId(tab.id, d.id);
    this.touch();
  }

  // ---------------------------------------------------------------- tab events

  async onTabCreated(tab) {
    const rec = this.ensureRecord(tab);
    if (rec.adopted) {
      delete rec.adopted;
      await this.settleAdopted(tab, rec);
      return;
    }
    if (rec.restored) {
      delete rec.restored;
      return;
    }
    if (tab.openerTabId != null) {
      rec.opener = tab.openerTabId;
      const src = this.state.tabs[tab.openerTabId];
      if (src?.huntId && !rec.huntId) rec.huntId = src.huntId;
    }
    this.touch();
  }

  async onTabActivated({ tabId, windowId }) {
    this.accrue();
    const prevId = this.state.activeByWindow[windowId];
    this.state.activeByWindow[windowId] = tabId;
    const prev = prevId != null && prevId !== tabId ? this.state.tabs[prevId] : null;
    if (prev) {
      // Idle time starts now, when you leave the tab, not when you opened it.
      this.markActive(prev);
      this.spawn(() => this.refreshCapture(prevId));
    }
    const tab = await this.p.tabs.get(tabId);
    if (!tab) return;
    const rec = this.ensureRecord(tab);
    if (rec.stage === 'shelved' && this.shelfGroupIds().has(tab.groupId)) {
      await this.restoreFromShelf(tabId, { activate: false });
      return;
    }
    if (rec.stage !== 'live') {
      // Chrome starts reloading an unloaded tab the moment it is selected, so by now
      // tab.discarded may already be false: go by Ebb's own record instead.
      this.queueRestore(tabId, rec.freeze, rec.url);
      rec.stage = 'live';
    }
    if (rec.visits === 0 || this.activeMs - rec.lastActiveClock >= REVISIT_GAP) rec.visits += 1;
    this.markActive(rec);
  }

  /** Entry point for tabs.onUpdated: bookkeeping in the queue, page work outside it. */
  async tabUpdated(tabId, change, tab) {
    const result = await this.dispatch('onTabUpdated', tabId, change, tab);
    if (result?.pageLoaded) this.spawn(() => this.pageLoaded(tabId));
  }

  async onTabUpdated(tabId, change, tab) {
    let rec = this.ensureRecord(tab);
    if (change.url) {
      const adopted = this.lateAdopt(tab, rec);
      if (adopted !== rec) {
        rec = adopted;
        delete rec.adopted;
        await this.settleAdopted(tab, rec);
      }
      rec.dirty = false;
    }
    if (change.title) rec.title = change.title;
    if (change.favIconUrl) rec.favIconUrl = change.favIconUrl;
    if (change.discarded === true && rec.stage === 'live') rec.stage = 'resting';
    if ('groupId' in change) await this.onGroupChange(tab, rec, change.groupId);
    if (this.state.pendingDiscard[tabId]) await this.discardPending(tab);
    this.touch();
    return { pageLoaded: change.status === 'complete' };
  }

  async onGroupChange(tab, rec, groupId) {
    const shelfIds = this.shelfGroupIds();
    if (rec.stage === 'shelved' && !shelfIds.has(groupId)) {
      rec.stage = tab.discarded ? 'resting' : 'live';
      rec.visits += 1;
      this.markActive(rec);
      await this.log({ type: 'restore', from: 'shelf', host: hostOf(rec.url) });
    } else if (rec.stage !== 'shelved' && shelfIds.has(groupId)) {
      rec.stage = 'shelved';
      rec.shelvedAt = this.now();
      rec.shelvedClock = this.activeMs;
      await this.log({ type: 'shelve', host: hostOf(rec.url), reason: 'manual' });
    }
  }

  /** In the queue: what to do now that a page has loaded. */
  async takePageWork(tabId) {
    const tab = await this.p.tabs.get(tabId);
    if (!tab || tab.discarded || !isWebUrl(tab.url)) return null; // pending work waits for the real load
    const rec = this.ensureRecord(tab);
    const pending = this.state.pendingRestore[tabId] || null;
    if (pending) delete this.state.pendingRestore[tabId];
    const freeze = pending && normalizeUrl(pending.url) === normalizeUrl(tab.url) ? pending.freeze : null;
    let signals = false;
    if (this.settings.mission && !this.settings.paused && rec.huntId && rec.signalsUrl !== tab.url) {
      // An offer needs at least two other tabs in the hunt, so skip small hunts entirely.
      const size = Object.values(this.state.tabs).filter((r) => r.huntId === rec.huntId).length;
      if (size >= 3) {
        rec.signalsUrl = tab.url;
        signals = true;
      }
    }
    this.touch();
    return { freeze, signals };
  }

  /**
   * Outside the queue: a page finished loading (or changed URL in place).
   * Put back the scroll position if one is waiting, then look for "mission accomplished".
   */
  async pageLoaded(tabId) {
    const work = await this.dispatch('takePageWork', tabId);
    if (!work) return;
    if (work.freeze) await this.p.tabs.sendMessage(tabId, { type: 'ebb:restore', freeze: work.freeze }, 1500);
    if (!work.signals) return;
    await (this.p.sleep ? this.p.sleep(SIGNALS_DELAY) : new Promise((r) => setTimeout(r, SIGNALS_DELAY)));
    const signals = await this.p.tabs.sendMessage(
      tabId,
      { type: 'ebb:signals', reference: REFERENCE_RE.source, flags: REFERENCE_RE.flags },
      1500,
    );
    if (!signals) return;
    const toast = await this.dispatch('onPageSignals', tabId, signals);
    if (toast) await this.p.tabs.sendMessage(tabId, { type: 'ebb:toast', toast }, 1500);
  }

  async onPageSignals(tabId, raw) {
    if (!raw || typeof raw !== 'object' || !this.settings.mission || this.settings.paused) return null;
    const tab = await this.p.tabs.get(tabId);
    if (!tab || !isWebUrl(tab.url)) return null;
    const rec = this.ensureRecord(tab);
    const hunt = rec.huntId && this.state.hunts[rec.huntId];
    if (!hunt || (hunt.offeredAt && this.now() - hunt.offeredAt < OFFER_COOLDOWN)) return null;
    const signals = {
      url: tab.url,
      title: typeof raw.title === 'string' ? raw.title.slice(0, 300) : '',
      headings: Array.isArray(raw.headings) ? raw.headings.slice(0, 12).map((h) => String(h).slice(0, 300)) : [],
      hasReference: raw.hasReference === true,
    };
    const mission = detectMission(signals);
    if (!mission) return null;
    const others = (await this.huntTabs(hunt.id)).filter(({ tab: t }) => t.id !== tab.id);
    if (others.length < 2) return null;
    hunt.offeredAt = this.now();
    this.touch();
    const word = MISSION_WORDS[mission.kind] || MISSION_WORDS.done;
    return {
      text: `${word}? Tuck away the ${others.length} other tabs from “${huntLabel(hunt)}”. They’ll wait in your Library.`,
      actions: [
        { id: 'tuck', label: 'Tuck away', data: { huntId: hunt.id } },
        { id: 'dismiss', label: 'Not now' },
      ],
      timeoutMs: 15000,
    };
  }

  /** Tabs of a hunt that Ebb may act on right now. */
  async huntTabs(huntId) {
    const tabs = await this.p.tabs.query({ windowType: 'normal' });
    const ctx = this.ctx({ paused: false });
    const shelfIds = this.shelfGroupIds();
    return tabs
      .map((t) => ({ tab: t, rec: this.ensureRecord(t) }))
      .filter(({ tab, rec }) => rec.huntId === huntId && !protection(tab, rec, ctx) && !this.heldByGroup(tab, shelfIds));
  }

  async onTabRemoved(tabId, { windowId, isWindowClosing } = {}) {
    delete this.state.pendingRestore[tabId];
    delete this.state.pendingDiscard[tabId];
    delete this.state.spawns[tabId];
    if (this.expectedRemovals.delete(tabId)) {
      delete this.state.tabs[tabId];
      this.touch();
      return;
    }
    const rec = this.state.tabs[tabId];
    delete this.state.tabs[tabId];
    if (windowId != null && this.state.activeByWindow[windowId] === tabId) delete this.state.activeByWindow[windowId];
    if (rec && isWindowClosing && isWebUrl(rec.url)) {
      // The window may be reopened, or the browser is shutting down: keep the record a while.
      (this.state.limbo[normalizeUrl(rec.url)] ||= []).push({ rec, at: this.now() });
    }
    this.touch();
  }

  /** Shelved and unloaded tabs of a window that stayed closed go to the Library. */
  async settleLimbo(now) {
    for (const [key, list] of Object.entries(this.state.limbo)) {
      const waiting = [];
      for (const entry of list) {
        if (now - entry.at < LIMBO_MS) {
          waiting.push(entry);
        } else if (entry.rec.stage === 'shelved' || entry.rec.stage === 'resting') {
          await this.p.repo.put('library', this.libraryItem(entry.rec, { reason: 'window-closed' }));
          await this.log({ type: 'archive', from: entry.rec.stage, host: hostOf(entry.rec.url), reason: 'window-closed' });
        }
      }
      if (waiting.length) this.state.limbo[key] = waiting;
      else delete this.state.limbo[key];
      this.touch();
    }
  }

  async onTabReplaced(addedTabId, removedTabId) {
    this.replaceTabId(removedTabId, addedTabId);
  }

  async onTabAttached(tabId, { newWindowId }) {
    const rec = this.state.tabs[tabId];
    if (!rec) return;
    rec.windowId = newWindowId;
    this.touch();
  }

  async onGroupRemoved(group) {
    if (this.state.shelf[group.windowId] === group.id) {
      delete this.state.shelf[group.windowId];
      this.touch();
    }
  }

  /** A main-frame navigation committed: decide which hunt the tab belongs to. */
  async onNavCommitted({ tabId, frameId, url, transitionType }) {
    if (frameId !== 0 || !isWebUrl(url)) return;
    const tab = await this.p.tabs.get(tabId);
    if (!tab) return;
    const before = this.state.tabs[tabId]?.url;
    let rec = this.ensureRecord(tab);
    const adopted = this.lateAdopt(tab, rec);
    if (adopted !== rec) {
      rec = adopted;
      delete rec.adopted;
      await this.settleAdopted(tab, rec);
    }
    // A tab Ebb brought back (or adopted after a restart) keeps its hunt when it first loads,
    // whatever transition type the browser reports for that load.
    const restoring = rec.keepHuntOnce && rec.huntId && normalizeUrl(url) === normalizeUrl(before || rec.url);
    delete rec.keepHuntOnce;
    rec.url = url;
    rec.kind = classify(url);
    rec.dirty = false;
    if (restoring) {
      rec.fresh = false;
      this.touch();
      return;
    }
    const search = parseSearch(url);
    const current = rec.huntId ? this.state.hunts[rec.huntId] : null;
    const refining = Boolean(search && rec.lastSearchClock != null && this.activeMs - rec.lastSearchClock < 10 * MIN);
    const decision = decideHunt({ current, url, transition: transitionType, search, refining });
    if (decision.action === 'new') {
      rec.huntId = this.createHunt(decision.hunt).id;
    } else if (decision.addQuery && current && !current.queries.includes(decision.addQuery)) {
      current.queries = [...current.queries, decision.addQuery].slice(-10);
    }
    if (search) rec.lastSearchClock = this.activeMs;
    rec.fresh = false;
    if (tab.active) this.markActive(rec);
    this.touch();
  }

  /** A page opened a new tab. Background tabs may go to the Later lane instead. */
  async onNavCreatedTarget({ sourceTabId, tabId, url }) {
    const tab = await this.p.tabs.get(tabId);
    if (!tab) return;
    const rec = this.ensureRecord(tab);
    const src = this.state.tabs[sourceTabId];
    rec.opener = sourceTabId;
    if (src?.huntId && !rec.huntId) rec.huntId = src.huntId;
    this.touch();
    if (tab.active || this.settings.paused || !isWebUrl(url) || !src || !isWebUrl(src.url)) return;
    const s = this.settings;
    const { queue, history } = decideLater({
      mode: s.laterMode,
      allow: s.laterAllow,
      windowMin: s.laterWindowMin,
      now: this.now(),
      history: this.state.spawns[sourceTabId] || [],
    });
    this.state.spawns[sourceTabId] = history;
    if (!queue) return;
    const info = await this.p.tabs.sendMessage(sourceTabId, { type: 'ebb:link-info', url }, 300);
    const title = (info && typeof info.text === 'string' && info.text) || prettyUrl(url);
    const item = await this.addLater({ url, title, source: { url: src.url, title: src.title || '', huntId: src.huntId || null } });
    this.expectedRemovals.add(tabId);
    await this.p.tabs.remove(tabId);
    delete this.state.tabs[tabId];
    await this.log({ type: 'later', host: hostOf(url) });
    this.toast(sourceTabId, {
      text: `Saved to Later: ${title}`,
      actions: [{ id: 'open-later', label: 'Open now', data: { laterId: item.id } }],
      timeoutMs: 6000,
    });
  }

  // ---------------------------------------------------------------- Later lane

  async addLater({ url, title, source = null }) {
    const item = { id: this.p.id('later'), url, title: title || prettyUrl(url), savedAt: this.now(), openedAt: null, source };
    await this.p.repo.put('later', item);
    this.state.counts.later = (this.state.counts.later || 0) + 1;
    this.touch();
    return item;
  }

  async openLater(id, { active = true, windowId, opener } = {}) {
    const item = await this.p.repo.get('later', id);
    if (!item) return null;
    const props = opener
      ? { url: item.url, active, windowId: opener.windowId, index: opener.index + 1, openerTabId: opener.id }
      : await this.placeNewTab({ url: item.url, active }, windowId);
    const tab = await this.createTab(props);
    if (!tab) return null;
    const rec = this.ensureRecord(tab);
    if (item.source?.huntId && this.state.hunts[item.source.huntId]) {
      rec.huntId = item.source.huntId;
      rec.keepHuntOnce = true;
    }
    rec.restored = true;
    rec.fresh = false;
    await this.p.repo.delete('later', id);
    this.state.counts.later = Math.max(0, (this.state.counts.later || 0) - 1);
    await this.log({ type: 'open-later', host: hostOf(item.url) });
    this.touch();
    return tab;
  }

  async removeLater(id) {
    await this.p.repo.delete('later', id);
    this.state.counts.later = (await this.p.repo.getAll('later')).length;
    this.touch();
  }

  async expireLater(now) {
    const items = await this.p.repo.getAll('later');
    for (const item of items) {
      if (!isExpired(item, now, this.settings.laterExpireDays)) continue;
      await this.p.repo.put('library', {
        id: this.p.id('lib'),
        url: item.url,
        title: item.title,
        favIconUrl: '',
        kind: classify(item.url),
        huntId: item.source?.huntId || null,
        huntName: 'Later',
        reason: 'later-expired',
        batchId: null,
        archivedAt: now,
        freeze: null,
        excerpt: '',
        description: '',
        visits: 0,
        fromStage: 'later',
      });
      await this.p.repo.delete('later', item.id);
      await this.log({ type: 'archive', from: 'later', host: hostOf(item.url), reason: 'later-expired' });
    }
    this.state.counts.later = (await this.p.repo.getAll('later')).length;
    this.touch();
  }

  async sendTabToLater(tab) {
    if (!tab || !isWebUrl(tab.url) || tab.pinned) return null;
    const rec = this.ensureRecord(tab);
    const item = await this.addLater({ url: tab.url, title: tab.title || rec.title, source: { url: '', title: '', huntId: rec.huntId || null } });
    this.expectedRemovals.add(tab.id);
    await this.p.tabs.remove(tab.id);
    delete this.state.tabs[tab.id];
    await this.log({ type: 'later', host: hostOf(tab.url) });
    this.touch();
    return item;
  }

  async saveLinkToLater(url, sourceTab) {
    if (!isWebUrl(url)) return null;
    const src = sourceTab ? this.state.tabs[sourceTab.id] : null;
    const info = sourceTab ? await this.p.tabs.sendMessage(sourceTab.id, { type: 'ebb:link-info', url }, 300) : null;
    const title = (info && typeof info.text === 'string' && info.text) || prettyUrl(url);
    const item = await this.addLater({ url, title, source: { url: src?.url || '', title: src?.title || '', huntId: src?.huntId || null } });
    await this.log({ type: 'later', host: hostOf(url) });
    if (sourceTab) this.toast(sourceTab.id, { text: `Saved to Later: ${title}`, timeoutMs: 3500 });
    return item;
  }

  // ---------------------------------------------------------------- batches

  /** Mission accomplished: archive the other tabs of the hunt and keep a receipt. */
  async tuckHunt(huntId, exceptTabId = null) {
    const hunt = this.state.hunts[huntId];
    if (!hunt) return { count: 0 };
    const batchId = this.p.id('batch');
    const entries = (await this.huntTabs(huntId)).filter(({ tab }) => tab.id !== exceptTabId);
    let count = 0;
    for (const { tab, rec } of entries) {
      await this.archiveTab(tab, rec, { reason: 'mission', batchId, type: 'tuck' });
      count += 1;
    }
    if (exceptTabId != null) {
      const receiptTab = await this.p.tabs.get(exceptTabId);
      if (receiptTab && isWebUrl(receiptTab.url)) {
        await this.p.repo.put('library', {
          ...this.libraryItem(this.ensureRecord(receiptTab), { reason: 'receipt', batchId }),
          kind: 'receipt',
        });
      }
    }
    hunt.doneAt = this.now();
    this.state.lastBatch = {
      id: batchId,
      kind: 'tuck',
      at: this.now(),
      count,
      label: `Tucked away ${plural(count, 'tab')} from “${huntLabel(hunt)}”`,
    };
    this.touch();
    return { count, batchId };
  }

  /** Bankruptcy with insurance: every tab Ebb may touch goes to the Library as one batch. */
  async freshStart() {
    const tabs = await this.p.tabs.query({ windowType: 'normal' });
    const ctx = this.ctx({ paused: false });
    const shelfIds = this.shelfGroupIds();
    const batchId = this.p.id('batch');
    let count = 0;
    for (const tab of tabs) {
      const rec = this.ensureRecord(tab);
      if (protection(tab, rec, ctx) || this.heldByGroup(tab, shelfIds)) continue;
      await this.archiveTab(tab, rec, { reason: 'fresh-start', batchId, capture: false });
      count += 1;
    }
    this.state.lastBatch = { id: batchId, kind: 'fresh-start', at: this.now(), count, label: `Fresh start: ${plural(count, 'tab')} moved to the Library` };
    this.touch();
    return { count, batchId };
  }

  async shelveWhere(predicate) {
    const tabs = await this.p.tabs.query({ windowType: 'normal' });
    const ctx = this.ctx({ paused: false });
    const shelfIds = this.shelfGroupIds();
    let count = 0;
    for (const tab of tabs) {
      const rec = this.ensureRecord(tab);
      if (rec.stage === 'shelved' || shelfIds.has(tab.groupId) || !predicate(rec)) continue;
      if (protection(tab, rec, ctx) || this.heldByGroup(tab, shelfIds)) continue;
      if (await this.shelve(tab, rec, 'manual')) count += 1;
    }
    return count;
  }

  /** Undo a batch. Its tabs come back unloaded, so nothing reloads all at once. */
  async undoBatch(batchId) {
    const items = (await this.p.repo.getAll('library'))
      .filter((i) => i.batchId === batchId && i.reason !== 'receipt')
      .sort((a, b) => a.archivedAt - b.archivedAt);
    let count = 0;
    for (const item of items) {
      if (await this.restoreItem(item.id, { background: true, from: 'undo' })) count += 1;
    }
    for (const item of await this.p.repo.getAll('library')) {
      if (item.batchId === batchId && item.reason === 'receipt') await this.p.repo.delete('library', item.id);
    }
    if (this.state.lastBatch?.id === batchId) this.state.lastBatch = null;
    if (this.state.resume?.batchId === batchId) this.state.resume = null;
    this.touch();
    return { count };
  }

  // ---------------------------------------------------------------- resume

  dismissResume() {
    this.state.resume = null;
    if (this.state.startup) this.state.startup.dismissed = true;
    this.touch();
  }

  /** Keep one hunt in view and shelve the rest. */
  async focusHunt(huntId) {
    const count = await this.shelveWhere((rec) => rec.huntId !== huntId);
    this.dismissResume();
    return { count };
  }

  /** Reopen a hunt whose tabs did not come back after a restart. */
  async reopenHunt(huntId) {
    const batchId = this.state.resume?.batchId;
    const items = (await this.p.repo.getAll('library'))
      .filter((i) => i.huntId === huntId && i.reason !== 'receipt' && (!batchId || i.batchId === batchId))
      .sort((a, b) => b.archivedAt - a.archivedAt);
    let count = 0;
    for (const [i, item] of items.entries()) {
      if (await this.restoreItem(item.id, { active: i === 0, background: i > 0, from: 'resume' })) count += 1;
    }
    this.dismissResume();
    return { count };
  }

  // ---------------------------------------------------------------- keep

  /** mode: 'week' | 'always' | null (stop keeping) | 'toggle' */
  async keepTab(tabId, mode) {
    const tab = await this.p.tabs.get(tabId);
    if (!tab) return { ok: false };
    const rec = this.ensureRecord(tab);
    if (mode === 'toggle') mode = rec.keep || rec.keepUntil > this.now() ? null : 'week';
    rec.keep = mode === 'always' ? 'always' : null;
    rec.keepUntil = mode === 'week' ? this.now() + 7 * DAY : 0;
    this.markActive(rec);
    if (mode && rec.stage === 'shelved' && this.shelfGroupIds().has(tab.groupId)) await this.restoreFromShelf(tabId, { activate: false });
    return { ok: true, mode };
  }

  /** Keep from the page (shortcut or context menu), with a toast saying what happened. */
  async keepFromPage(tabId, mode) {
    const result = await this.keepTab(tabId, mode);
    if (!result.ok) return result;
    const text =
      result.mode === 'week'
        ? 'Kept for a week. Ebb won’t tidy this tab.'
        : result.mode === 'always'
          ? 'Kept. Ebb won’t tidy this tab.'
          : 'No longer kept. Ebb may tidy this tab after you leave it.';
    this.toast(tabId, { text, timeoutMs: 3000 });
    return result;
  }

  // ---------------------------------------------------------------- maintenance

  /** Keep each Shelf collapsed, counted and at the far end of the tab bar. */
  async maintainShelves() {
    for (const [windowKey, groupId] of Object.entries(this.state.shelf)) {
      const windowId = Number(windowKey);
      const group = await this.p.groups.get(groupId);
      const inGroup = group ? await this.p.tabs.query({ groupId }) : [];
      if (!group || !inGroup.length) {
        delete this.state.shelf[windowKey];
        this.touch();
        continue;
      }
      const anyActive = inGroup.some((t) => t.active);
      const title = `${SHELF_TITLE} · ${inGroup.length}`;
      const props = {};
      if (group.title !== title) props.title = title;
      if (!group.collapsed && !anyActive) props.collapsed = true;
      if (Object.keys(props).length) await this.p.groups.update(groupId, props);
      if (anyActive) continue;
      const all = await this.p.tabs.query({ windowId });
      const last = Math.max(...all.map((t) => t.index));
      if (Math.max(...inGroup.map((t) => t.index)) < last) await this.p.groups.move(groupId, { index: -1 });
    }
  }

  async refreshHostMult() {
    const now = this.now();
    if (now - this.state.hostMultAt < 10 * MIN) return;
    const since = now - 90 * DAY;
    this.state.hostMult = hostMultipliers(await this.p.repo.getAllSince('ledger', 'at', since), { since });
    this.state.hostMultAt = now;
    this.touch();
  }

  async daily(now) {
    if (now - this.state.lastDaily < DAY) return;
    this.state.lastDaily = now;
    await this.expireLater(now);
    this.state.hostMultAt = 0;
    await this.refreshHostMult();
    await this.p.repo.deleteBefore('ledger', 'at', now - LEDGER_RETENTION_MS);
    const live = new Set(Object.values(this.state.tabs).map((r) => r.huntId));
    for (const [id, hunt] of Object.entries(this.state.hunts)) {
      if (!live.has(id) && now - hunt.lastActiveAt > 30 * DAY) delete this.state.hunts[id];
    }
    this.touch();
  }

  // ---------------------------------------------------------------- messages

  async onMessage(msg, sender = {}) {
    const tab = sender.tab;
    switch (msg?.type) {
      case 'ebb:dirty': {
        const rec = tab && this.state.tabs[tab.id];
        if (rec && rec.dirty !== Boolean(msg.dirty)) {
          rec.dirty = Boolean(msg.dirty);
          this.touch();
        }
        return { ok: true };
      }
      case 'ebb:toast-action':
        return this.onToastAction(msg, tab);
      case 'panel:state':
        return this.viewModel(msg);
      case 'panel:library':
        return this.library(msg);
      case 'panel:do':
        return this.panelAction(msg);
      case 'panel:settings': {
        const next = withDefaults({ ...this.settings, ...(msg.patch && typeof msg.patch === 'object' ? msg.patch : {}) });
        if (JSON.stringify(next) !== JSON.stringify(this.settings)) {
          this.settings = next;
          this.touch();
        }
        return this.settings;
      }
      case 'panel:export':
        return this.exportData();
      case 'panel:import':
        return this.importData(msg.data);
      default:
        return undefined;
    }
  }

  async onToastAction({ action, data = {} }, tab) {
    switch (action) {
      case 'tuck': {
        const { count, batchId } = await this.tuckHunt(data.huntId, tab?.id ?? null);
        if (!count) return { toast: { text: 'Nothing to tuck away.', timeoutMs: 3000 } };
        return {
          toast: {
            text: `Tucked away ${plural(count, 'tab')}. They’re in Ebb’s Library.`,
            actions: [{ id: 'undo', label: 'Undo', data: { batchId } }],
            timeoutMs: 8000,
          },
        };
      }
      case 'undo': {
        const { count } = await this.undoBatch(data.batchId);
        return { toast: { text: `Brought back ${plural(count, 'tab')}.`, timeoutMs: 3000 } };
      }
      case 'open-later': {
        const item = await this.p.repo.get('later', data.laterId);
        if (!item) return { toast: { text: 'Already opened.', timeoutMs: 2500 } };
        await this.openLater(data.laterId, { active: false, opener: tab });
        return { toast: { text: 'Opened in a background tab.', timeoutMs: 2500 } };
      }
      default:
        return { ok: true };
    }
  }

  async panelAction(msg) {
    switch (msg.action) {
      case 'activate-tab': {
        const tab = await this.p.tabs.get(msg.tabId);
        if (!tab) return { ok: false };
        const rec = this.ensureRecord(tab);
        if (rec.stage === 'shelved' && this.shelfGroupIds().has(tab.groupId)) await this.restoreFromShelf(tab.id, { activate: true });
        else await this.p.tabs.update(tab.id, { active: true });
        await this.p.windows.update(tab.windowId, { focused: true });
        return { ok: true };
      }
      case 'shelve-tab': {
        const tab = await this.p.tabs.get(msg.tabId);
        if (!tab || tab.active || tab.pinned || !isWebUrl(tab.url)) return { ok: false };
        return { ok: await this.shelve(tab, this.ensureRecord(tab), 'manual') };
      }
      case 'archive-tab': {
        const tab = await this.p.tabs.get(msg.tabId);
        if (!tab || tab.pinned || !isWebUrl(tab.url)) return { ok: false };
        await this.archiveTab(tab, this.ensureRecord(tab), { reason: 'manual' });
        return { ok: true };
      }
      case 'keep-tab':
        return this.keepTab(msg.tabId, msg.mode ?? null);
      case 'later-tab': {
        const tab = await this.p.tabs.get(msg.tabId);
        return { ok: Boolean(await this.sendTabToLater(tab)) };
      }
      case 'shelve-hunt':
        return { count: await this.shelveWhere((rec) => rec.huntId === msg.huntId) };
      case 'tuck-hunt':
        return this.tuckHunt(msg.huntId, null);
      case 'restore-item': {
        const win = await this.p.windows.getLastFocused();
        return { ok: Boolean(await this.restoreItem(msg.id, { active: true, windowId: msg.windowId ?? win?.id })) };
      }
      case 'delete-item':
        await this.p.repo.delete('library', msg.id);
        this.touch();
        return { ok: true };
      case 'undo':
      case 'restore-batch':
        return this.undoBatch(msg.batchId);
      case 'open-later': {
        const win = await this.p.windows.getLastFocused();
        return { ok: Boolean(await this.openLater(msg.id, { active: true, windowId: msg.windowId ?? win?.id })) };
      }
      case 'remove-later':
        await this.removeLater(msg.id);
        return { ok: true };
      case 'fresh-start':
        return this.freshStart();
      case 'focus-hunt':
        return this.focusHunt(msg.huntId);
      case 'reopen-hunt':
        return this.reopenHunt(msg.huntId);
      case 'dismiss-resume':
        this.dismissResume();
        return { ok: true };
      case 'dismiss-batch':
        this.state.lastBatch = null;
        this.touch();
        return { ok: true };
      case 'clear-library':
        await this.p.repo.clear('library');
        this.touch();
        return { ok: true };
      default:
        return { ok: false, error: `unknown action ${msg.action}` };
    }
  }

  // ---------------------------------------------------------------- views

  async viewModel({ windowId } = {}) {
    const now = this.now();
    const tabs = await this.p.tabs.query({ windowType: 'normal' });
    const focused = windowId != null ? { id: windowId } : await this.p.windows.getLastFocused();
    const shelfIds = this.shelfGroupIds();
    const ctx = this.ctx({ paused: false });
    const windows = new Map();
    const totals = { live: 0, resting: 0, shelved: 0 };

    for (const tab of tabs) {
      const rec = this.ensureRecord(tab);
      const why = tab.active ? null : protection(tab, rec, ctx);
      const age = Math.max(0, this.activeMs - rec.lastActiveClock);
      let stage = rec.stage;
      if (shelfIds.has(tab.groupId)) stage = 'shelved';
      else if (stage === 'shelved') stage = tab.discarded ? 'resting' : 'live';
      else if (tab.discarded) stage = 'resting';
      totals[stage] = (totals[stage] || 0) + 1;
      const url = tab.url || rec.url;
      const view = {
        tabId: tab.id,
        windowId: tab.windowId,
        index: tab.index,
        title: tab.title || rec.title || prettyUrl(url),
        url,
        host: hostOf(url),
        stage,
        active: tab.active,
        pinned: tab.pinned,
        grouped: this.heldByGroup(tab, shelfIds),
        protected: why,
        keep: rec.keep,
        keepUntil: rec.keepUntil,
        visits: rec.visits,
        next: tab.active || why ? null : nextTransition(stage, age, this.thresholdsFor(rec)),
      };
      if (!windows.has(tab.windowId)) windows.set(tab.windowId, { windowId: tab.windowId, hunts: new Map(), steady: [] });
      const w = windows.get(tab.windowId);
      if (tab.pinned || rec.kind === 'app' || rec.keep === 'always' || !isWebUrl(url)) {
        w.steady.push(view);
        continue;
      }
      const hunt = rec.huntId ? this.state.hunts[rec.huntId] : null;
      const key = hunt ? hunt.id : '_loose';
      if (!w.hunts.has(key)) {
        w.hunts.set(key, {
          id: hunt ? hunt.id : null,
          name: hunt ? huntLabel(hunt) : 'Loose tabs',
          origin: hunt?.origin || 'loose',
          lastActiveAt: hunt?.lastActiveAt || 0,
          tabs: [],
        });
      }
      w.hunts.get(key).tabs.push(view);
    }

    const windowList = [...windows.values()]
      .map((w) => ({
        windowId: w.windowId,
        current: w.windowId === focused?.id,
        steady: w.steady.sort((a, b) => a.index - b.index),
        hunts: [...w.hunts.values()]
          .map((h) => ({
            ...h,
            tabs: h.tabs.sort((a, b) => a.index - b.index),
            counts: {
              live: h.tabs.filter((t) => t.stage === 'live').length,
              resting: h.tabs.filter((t) => t.stage === 'resting').length,
              shelved: h.tabs.filter((t) => t.stage === 'shelved').length,
            },
            lastActiveAt: h.tabs.some((t) => t.active) ? now : h.lastActiveAt,
          }))
          .sort((a, b) => b.lastActiveAt - a.lastActiveAt),
      }))
      .sort((a, b) => Number(b.current) - Number(a.current));

    const later = (await this.p.repo.getAll('later')).filter((i) => !i.openedAt).sort((a, b) => b.savedAt - a.savedAt);
    const since = now - 7 * DAY;
    const week = summarize(await this.p.repo.getAllSince('ledger', 'at', since), { since });
    const batch = this.state.lastBatch;

    return {
      now,
      activeMinutes: Math.round(this.activeMs / MIN),
      settings: this.settings,
      totals,
      windows: windowList,
      later,
      libraryCount: await this.p.repo.count('library'),
      ledger: { week, sentence: ledgerSentence(week), hostMult: this.state.hostMult },
      resume: this.state.resume,
      lastBatch: batch && now - batch.at < BATCH_VISIBLE_MS ? batch : null,
    };
  }

  async library({ q = '', limit = 60, offset = 0 } = {}) {
    const terms = String(q).toLowerCase().split(/\s+/).filter(Boolean);
    const all = (await this.p.repo.getAll('library')).sort((a, b) => b.archivedAt - a.archivedAt);
    const hits = terms.length
      ? all.filter((i) => {
          const hay = `${i.title} ${i.url} ${i.huntName} ${i.excerpt} ${i.description}`.toLowerCase();
          return terms.every((t) => hay.includes(t));
        })
      : all;
    return { total: hits.length, items: hits.slice(offset, offset + limit) };
  }

  async exportData() {
    return {
      app: 'ebb',
      version: 1,
      exportedAt: new Date(this.now()).toISOString(),
      settings: this.settings,
      hunts: this.state.hunts,
      library: await this.p.repo.getAll('library'),
      later: await this.p.repo.getAll('later'),
      ledger: await this.p.repo.getAll('ledger'),
    };
  }

  async importData(data) {
    if (!data || typeof data !== 'object' || data.app !== 'ebb') return { ok: false, error: 'This is not an Ebb export file.' };
    const valid = {
      library: (i) => typeof i.id === 'string' && isWebUrl(i.url) && Number.isFinite(i.archivedAt),
      later: (i) => typeof i.id === 'string' && isWebUrl(i.url) && Number.isFinite(i.savedAt),
      ledger: (i) => typeof i.id === 'string' && typeof i.type === 'string' && Number.isFinite(i.at),
    };
    const counts = {};
    for (const store of ['library', 'later', 'ledger']) {
      const items = Array.isArray(data[store]) ? data[store].filter((i) => i && typeof i === 'object' && valid[store](i)) : [];
      for (const item of items) await this.p.repo.put(store, item);
      counts[store] = items.length;
    }
    if (data.hunts && typeof data.hunts === 'object') {
      for (const [id, hunt] of Object.entries(data.hunts)) {
        if (!this.state.hunts[id] && hunt && typeof hunt === 'object' && hunt.id === id) this.state.hunts[id] = hunt;
      }
    }
    this.state.counts.later = (await this.p.repo.getAll('later')).length;
    this.touch();
    return { ok: true, counts };
  }
}
