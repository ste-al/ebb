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

export const STATE_VERSION = 2;

export function emptyState() {
  return {
    version: STATE_VERSION,
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
    startupSession: null, // browser session whose startup event has already been handled
    startup: null,
    resume: null,
    lastBatch: null,
    hostMult: {},
    hostMultAt: 0,
    lastDaily: 0,
    counts: { later: 0 },
    intro: { shelf: false, library: false }, // first-time explanations already shown
    introPending: null, // { kind, count }: an explanation waiting for you to come back
  };
}

/** Stored state of this or an older version, brought up to date (text snippets move out in load()). */
function migrate(stored) {
  const base = emptyState();
  if (!stored || typeof stored !== 'object' || !(stored.version >= 1 && stored.version <= STATE_VERSION)) return base;
  return {
    ...base,
    ...stored,
    version: STATE_VERSION,
    clock: { ...base.clock, ...stored.clock },
    counts: { ...base.counts, ...stored.counts },
    intro: { ...base.intro, ...stored.intro },
  };
}

/** Never loaded (restored lazily) or unloaded: either way the tab holds no page right now. */
const unloaded = (tab) => Boolean(tab && (tab.discarded || tab.status === 'unloaded'));

const isShelfTitle = (title) => SHELF_TITLE_RE.test(String(title || ''));
const XML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const xml = (text) => String(text).replace(/[&<>"']/g, (c) => XML_ENTITIES[c]);
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
    this.flushDelay = ports.flushDelayMs ?? 1000;
    this.introducing = false;
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
      if (got['ebb:state']?.version === 1) await this.moveSnippetsOut();
      await this.checkSession();
    })().finally(() => {
      this.loading = null;
    });
    await this.loading;
  }

  touch() {
    this.changed = true;
  }

  /** Version 1 kept text snippets in every tab record, which made each save large. */
  async moveSnippetsOut() {
    const records = [
      ...Object.values(this.state.tabs),
      ...Object.values(this.state.limbo).flat().map((entry) => entry.rec),
      ...Object.values(this.state.startup?.prev || {}).flat(),
    ];
    for (const rec of records) {
      if (rec.excerpt && isWebUrl(rec.url) && this.settings.captureText) {
        await this.p.repo.put('snapshots', { id: normalizeUrl(rec.url), url: rec.url, excerpt: rec.excerpt, description: rec.description || '', at: this.now() });
      }
      delete rec.excerpt;
      delete rec.description;
    }
    this.touch();
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
    else this.reconcile(tabs, { holdMissing: true });
  }

  /** Forget tabs that no longer exist and pick up ones Ebb has not seen. */
  reconcile(tabs, { holdMissing = false } = {}) {
    const byId = new Map(tabs.map((t) => [t.id, t]));
    for (const [id, rec] of Object.entries(this.state.tabs)) {
      const tab = byId.get(Number(id));
      if (tab && (!holdMissing || !isWebUrl(rec.url) || normalizeUrl(tab.url || tab.pendingUrl) === normalizeUrl(rec.url))) continue;
      // Most IDs matching can also mean Chrome reused some IDs on a real restart.
      // Keep the unmatched records available until onStartup or the normal limbo timeout.
      if (holdMissing && isWebUrl(rec.url)) (this.state.limbo[normalizeUrl(rec.url)] ||= []).push({ rec, at: this.now() });
      delete this.state.tabs[id];
      delete this.state.pendingRestore[id];
      delete this.state.pendingDiscard[id];
      delete this.state.spawns[id];
    }
    this.state.activeByWindow = {};
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
      excerptUrl: '', // the address whose text snippet is saved (in the snapshots store)
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
    if (!rec.fresh) return rec;
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
    if ((was === 'resting' || was === 'shelved') && !unloaded(tab) && !protection(tab, rec, this.ctx())) {
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

  async discoverShelves(tabs) {
    // Group IDs can change on restart. A group title alone is also a perfectly valid user-chosen name.
    const records = [...Object.values(this.state.tabs), ...Object.values(this.state.startup?.prev || {}).flat()];
    const shelvedUrls = new Set(records.filter((r) => r.stage === 'shelved').map((r) => normalizeUrl(r.url)));
    if (!shelvedUrls.size) return;
    const matches = new Map(); // every member of this group was on the Shelf
    for (const tab of tabs) {
      if (tab.groupId === -1 || matches.get(tab.groupId) === false) continue;
      matches.set(tab.groupId, shelvedUrls.has(normalizeUrl(tab.url || tab.pendingUrl)));
    }
    const candidates = new Map();
    for (const group of await this.p.groups.query({})) {
      if (!matches.get(group.id) || !isShelfTitle(group.title) || group.color !== 'grey' || this.state.shelf[group.windowId] != null) continue;
      candidates.set(group.windowId, candidates.has(group.windowId) ? null : group.id);
    }
    for (const [windowId, id] of candidates) if (id != null) this.state.shelf[windowId] = id;
  }

  // ---------------------------------------------------------------- install & startup

  async install(reason) {
    if (reason === 'install') {
      this.state = emptyState();
      this.settings = withDefaults({});
    }
    this.state.clock.lastTickAt = this.now();
    if (reason === 'install') this.state.installedClock = this.activeMs;
    const tabs = await this.p.tabs.query({ windowType: 'normal' });
    await this.discoverShelves(tabs);
    this.reconcile(tabs);
    if (!this.state.startup) for (const t of tabs) this.state.tabs[t.id].fresh = false;
    return { webTabIds: tabs.filter((t) => isWebUrl(t.url) && !t.discarded).map((t) => t.id) };
  }

  /** Browser start: tab ids changed, so keep the old records by URL and adopt restored tabs. */
  async startup() {
    const now = this.now();
    const sessionId = await this.p.session?.get();
    const previous = this.state.startup;
    // Tab events can start recovery before onStartup. Only the same browser session shares that recovery.
    if (sessionId != null ? this.state.startupSession === sessionId : previous && now < previous.adoptUntil) return;
    const prev = {};
    const keep = (rec) => {
      if (isWebUrl(rec.url)) (prev[normalizeUrl(rec.url)] ||= []).push(rec);
    };
    for (const rec of Object.values(this.state.tabs)) keep(rec);
    for (const list of Object.values(this.state.limbo)) for (const entry of list) keep(entry.rec);
    // Chrome may quit again while it is still restoring tabs. Offer the not-yet-matched records
    // to this session as well, after the more recent copies of any matching URLs.
    for (const list of Object.values(previous?.prev || {})) for (const rec of list) keep(rec);
    Object.assign(this.state, {
      tabs: {},
      shelf: {},
      activeByWindow: {},
      spawns: {},
      pendingRestore: {},
      pendingDiscard: {},
      limbo: {},
      resume: null,
      startupSession: sessionId ?? null,
      startup: { at: now, adoptUntil: now + ADOPT_MS, prev, adoptedHunts: {}, batchId: this.p.id('batch'), dismissed: false },
    });
    this.state.clock = { ...this.state.clock, lastTickAt: now, focused: true, idle: 'active' };
    const tabs = await this.p.tabs.query({ windowType: 'normal' });
    await this.discoverShelves(tabs);
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
    const closedByHunt = (startup.closedByHunt ||= {});
    for (const [url, list] of Object.entries(startup.prev)) {
      while (list.length) {
        const rec = list[0];
        await this.addToLibrary(await this.libraryItem(rec, { reason: 'session-end', batchId: startup.batchId }));
        const key = rec.huntId || '_';
        closedByHunt[key] = (closedByHunt[key] || 0) + 1;
        list.shift();
        this.touch();
      }
      delete startup.prev[url];
    }
    // If a Library write fails, the next tick can retry from the retained records.
    this.state.startup = null;
    for (const rec of Object.values(this.state.tabs)) rec.fresh = false;
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
    } else {
      this.maybeIntroduce();
    }
  }

  /**
   * Window focus moved. Leaving Chrome is a boundary, but focus can drop for a moment while
   * switching between Chrome windows, so the next tick acts on it rather than this event.
   */
  async onFocus(windowId) {
    this.accrue();
    this.state.clock.focused = windowId !== -1;
    if (windowId !== -1) {
      this.state.clock.idle = 'active';
      this.maybeIntroduce();
    }
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

      if (!unloaded(tab)) {
        const retryOk = rec.restFailedClock == null || this.activeMs - rec.restFailedClock >= REST_RETRY;
        if (!rests || !retryOk) continue;
        rests -= 1;
        const rested = await this.rest(tab, rec);
        if (!rested) continue;
        tab = rested;
      } else if (rec.stage === 'live') {
        rec.stage = 'resting';
        this.touch();
      }
      if (!boundary || moves <= 0 || target === 'resting') continue;

      if (rec.stage !== 'shelved') {
        if (this.settings.useShelf) {
          if (await this.shelve(tab, rec, 'idle')) moves -= 1;
        } else if (target === 'archived') {
          if (await this.archiveTab(tab, rec, { reason: 'idle' })) moves -= 1;
        }
      } else if (target === 'archived' && this.activeMs - (rec.shelvedClock ?? 0) >= MIN_SHELF_STAY) {
        if (await this.archiveTab(tab, rec, { reason: 'idle' })) moves -= 1;
      }
    }
    if (boundary && moves > 0) await this.applyBudget(moves, rests);
  }

  /** Soft budget: when a window shows more tabs than the budget, shelve the longest-idle ones. */
  async applyBudget(maxMoves, rests = MAX_RESTS_PER_PASS) {
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
      const visible = list.filter((t) => !t.pinned && !shelfIds.has(t.groupId) && !this.heldByGroup(t, shelfIds));
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
        if (!unloaded(t)) {
          if (!rests || (rec.restFailedClock != null && this.activeMs - rec.restFailedClock < REST_RETRY)) continue;
          rests -= 1;
        }
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
   * Read the current dirty flag even when an earlier capture already has the excerpt.
   */
  async captureInto(tab, rec, timeout = CAPTURE_TIMEOUT) {
    if (!tab || unloaded(tab) || !isWebUrl(tab.url)) return false;
    const wantText = this.settings.captureText && rec.excerptUrl !== tab.url;
    const res = await this.p.tabs.sendMessage(tab.id, { type: 'ebb:capture', text: wantText }, timeout);
    if (!res || typeof res !== 'object' || (res.url && res.url !== tab.url)) return false;
    await this.applyCaptureResult(rec, res, tab.url, wantText);
    return true;
  }

  async applyCaptureResult(rec, res, url, withText) {
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
      await this.p.repo.put('snapshots', {
        id: normalizeUrl(url),
        url,
        excerpt: res.excerpt.slice(0, 700),
        description: typeof res.description === 'string' ? res.description.slice(0, 300) : '',
        at: this.now(),
      });
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
    if (!rec || rec.url !== req.url || (res.url && res.url !== req.url)) return;
    await this.applyCaptureResult(rec, res, req.url, req.text);
  }

  // ---------------------------------------------------------------- actions on tabs

  /** Recheck Chrome after page and storage calls. A tab may have moved, navigated or become active meanwhile. */
  async actionTab(tab, rec, { move = false, individual = false, url = tab.url || tab.pendingUrl } = {}) {
    const current = await this.p.tabs.get(tab.id);
    if (!current || !isWebUrl(url) || (current.pendingUrl || current.url) !== url || current.pinned || rec.dirty) return null;
    // A direct command on one tab may target the current tab or one the user normally keeps.
    if (!individual && (protection(current, rec, this.ctx({ paused: false })) || (move && this.heldByGroup(current)))) return null;
    return current;
  }

  /** Unload a tab in place. It stays where it is and reloads when clicked. */
  async rest(tab, rec, { individual = false } = {}) {
    await this.captureInto(tab, rec);
    const current = await this.actionTab(tab, rec, { individual });
    if (!current || current.active) return null;
    if (unloaded(current)) return current;
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
  async shelve(tab, rec, reason, { individual = false } = {}) {
    if (!unloaded(tab) && !tab.active) {
      const rested = await this.rest(tab, rec, { individual });
      if (rested) tab = rested;
      else if (!individual) return false;
    }
    const current = await this.actionTab(tab, rec, { move: true, individual });
    if (!current || current.active) return false;
    const groupId = await this.addToShelf(current.windowId, current.id);
    if (groupId == null) return false;
    rec.stage = 'shelved';
    rec.shelvedAt = this.now();
    rec.shelvedClock = this.activeMs;
    this.touch();
    await this.log({ type: 'shelve', host: hostOf(rec.url), reason });
    if (reason === 'idle' || reason === 'budget') this.noteIntro('shelf');
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

  async libraryItem(rec, { reason, batchId = null }) {
    const hunt = rec.huntId ? this.state.hunts[rec.huntId] : null;
    const snapshot = this.settings.captureText && isWebUrl(rec.url) ? await this.p.repo.get('snapshots', normalizeUrl(rec.url)) : null;
    return {
      id: this.p.id('lib'),
      url: rec.url,
      key: normalizeUrl(rec.url),
      title: rec.title || prettyUrl(rec.url),
      favIconUrl: rec.favIconUrl || '',
      kind: rec.kind,
      huntId: rec.huntId || null,
      huntName: hunt ? huntLabel(hunt) : '',
      reason,
      batchId,
      archivedAt: this.now(),
      freeze: rec.freeze || null,
      excerpt: snapshot?.excerpt || rec.excerpt || '',
      description: snapshot?.description || rec.description || '',
      visits: rec.visits || 0,
      fromStage: rec.stage,
    };
  }

  /** Save to the Library, keeping one entry per page: an older entry for the same page is folded in. */
  async addToLibrary(item, { preferNewer = false, alreadySaved = false } = {}) {
    item.key = normalizeUrl(item.url);
    const copies = item.reason === 'receipt' ? [] : (await this.p.repo.findBy('library', 'key', item.key))
      .filter((old) => old.reason !== 'receipt' && !(alreadySaved && old.id === item.id))
      .sort((a, b) => b.archivedAt - a.archivedAt);
    if (preferNewer && copies.some((old) => old.archivedAt >= item.archivedAt)) return null;
    for (const old of copies) {
      item.excerpt ||= old.excerpt || '';
      item.description ||= old.description || '';
      item.freeze ||= old.freeze || null;
      item.visits = Math.max(item.visits || 0, old.visits || 0);
    }
    const oldIds = copies.map((old) => old.id).filter((id) => id !== item.id);
    if (!alreadySaved || oldIds.length) await this.p.repo.put('library', item, oldIds);
    return item;
  }

  async findLibraryItemByUrl(url) {
    const copies = await this.p.repo.findBy('library', 'key', normalizeUrl(url));
    copies.sort((a, b) => b.archivedAt - a.archivedAt);
    return copies.find((item) => item.url === url) || copies[0] || null;
  }

  /** Close a tab into the Library, keeping where you were and a text excerpt. */
  async archiveTab(tab, rec, { reason, batchId = null, type = 'archive' } = {}) {
    if (tab.status === 'complete') await this.captureInto(tab, rec, 400);
    if (rec.dirty) return null;
    const item = await this.libraryItem(rec, { reason, batchId });
    // Keep a recoverable copy before closing. Leave any older Library entry intact until Chrome succeeds.
    await this.p.repo.put('library', item);
    if (!(await this.closeSavedTab(tab, rec, { individual: reason === 'manual' }))) {
      await this.p.repo.delete('library', item.id);
      return null;
    }
    await this.addToLibrary(item, { alreadySaved: true });
    await this.log({ type, from: rec.stage, host: hostOf(rec.url), reason });
    if (reason === 'idle') this.noteIntro('library');
    return item;
  }

  /** Close only the page that was saved, and keep its live record if Chrome refuses. */
  async closeSavedTab(tab, rec, options) {
    const current = await this.actionTab(tab, rec, { move: true, ...options });
    if (!current) return false;
    await this.leaveShelfIfLast(current);
    this.expectedRemovals.add(tab.id);
    if (!(await this.p.tabs.remove(tab.id))) {
      this.expectedRemovals.delete(tab.id);
      return false;
    }
    delete this.state.tabs[tab.id];
    delete this.state.pendingRestore[tab.id];
    delete this.state.pendingDiscard[tab.id];
    this.touch();
    return true;
  }

  // ---------------------------------------------------------------- first-time explanations

  /** The first time Ebb moves tabs on its own, explain it once you are back. */
  noteIntro(kind) {
    if (this.state.intro[kind]) return;
    const pending = this.state.introPending;
    if (pending?.kind === kind) pending.count += 1;
    else if (!pending) this.state.introPending = { kind, count: 1 };
    this.touch();
  }

  introToast({ kind, count }) {
    if (kind === 'shelf') {
      return {
        text: `While you were away, Ebb moved ${plural(count, 'idle tab')} to the Shelf at the end of your tab bar. Click one there to bring it back.`,
        actions: [
          { id: 'show-shelf', label: 'Show me' },
          { id: 'dismiss', label: 'Got it' },
        ],
        timeoutMs: 20000,
      };
    }
    const where = this.settings.useShelf ? 'that sat unused on the Shelf' : 'you hadn’t used in a long time';
    return {
      text: `Ebb closed ${plural(count, 'tab')} ${where}. They’re in its Library with your place on each page: type “ebb” and a space in the address bar to find one.`,
      actions: [{ id: 'dismiss', label: 'Got it' }],
      timeoutMs: 20000,
    };
  }

  /** Called when you are back (active, Chrome focused): show a waiting explanation on your current page. */
  maybeIntroduce() {
    const pending = this.state.introPending;
    if (!pending || this.introducing || this.atBoundary()) return;
    this.introducing = true;
    const toast = this.introToast(pending);
    this.spawn(async () => {
      try {
        const win = await this.p.windows.getLastFocused();
        const [tab] = win ? await this.p.tabs.query({ active: true, windowId: win.id }) : [];
        if (!tab || unloaded(tab) || !isWebUrl(tab.url)) return; // try again on the next page you visit
        const res = await this.p.tabs.sendMessage(tab.id, { type: 'ebb:toast', toast }, 1000);
        if (res?.ok) await this.dispatch('introShown', pending.kind);
      } finally {
        this.introducing = false;
      }
    });
  }

  introShown(kind) {
    this.state.intro[kind] = true;
    if (this.state.introPending?.kind === kind) this.state.introPending = null;
    this.touch();
  }

  /**
   * Chrome keeps a tab group whose last tab is closed as a saved group (synced, when signed in).
   * Ungrouping the last Shelf tab before closing it deletes the group instead.
   */
  async leaveShelfIfLast(tab) {
    if (!this.shelfGroupIds().has(tab.groupId)) return;
    const left = await this.p.tabs.query({ groupId: tab.groupId });
    if (left.length <= 1) await this.p.tabs.ungroup([tab.id]);
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
    // Chrome expands a group when one of its tabs is selected; fold the rest of the Shelf away again.
    const shelfId = this.state.shelf[tab.windowId];
    if (shelfId != null) await this.p.groups.update(shelfId, { collapsed: true });
    rec.visits += 1;
    this.queueRestore(tabId, rec.freeze, rec.url);
    this.markActive(rec);
    await this.log({ type: 'restore', from: 'shelf', host: hostOf(rec.url) });
    await this.refreshHostMult();
    return true;
  }

  /**
   * Bring a Library item back. Recently closed tabs come back with their history.
   * options.active      open it in front (default) or behind the current tab
   * options.unloaded    open it unloaded (undo of a batch: nothing reloads all at once)
   * options.intoTabId   load it in this tab instead of a new one (the address bar's "current tab")
   */
  async restoreItem(id, { active = true, unloaded: restUnloaded = false, from = 'library', windowId, intoTabId } = {}) {
    const item = await this.p.repo.get('library', id);
    if (!item || !isWebUrl(item.url)) return null;
    if (!restUnloaded) {
      const open = await this.reuseOpenTab(item.url, active);
      if (open) {
        await this.p.repo.delete('library', id);
        await this.log({ type: 'restore', from, host: hostOf(item.url) });
        this.touch();
        return open;
      }
    }
    let tab = null;
    if (intoTabId != null) {
      tab = await this.p.tabs.update(intoTabId, { url: item.url, active: true });
    } else if (active && !restUnloaded) {
      tab = await this.sessionRestore(item);
      if (tab) tab = await this.settleRestoredTab(tab, windowId);
    }
    if (!tab) tab = await this.createTab(await this.placeNewTab({ url: item.url, active: active && !restUnloaded }, windowId));
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
    if (item.excerpt && this.settings.captureText) {
      await this.p.repo.put('snapshots', { id: normalizeUrl(item.url), url: item.url, excerpt: item.excerpt, description: item.description || '', at: this.now() });
    }
    Object.assign(rec, {
      huntId: item.huntId || rec.huntId,
      title: rec.title || item.title,
      freeze: item.freeze,
      excerptUrl: item.excerpt ? item.url : '',
      visits: Math.max(item.visits || 0, 1) + (restUnloaded ? 0 : 1),
      fresh: false,
      restored: true,
      keepHuntOnce: true,
    });
    this.markActive(rec);
    if (restUnloaded) {
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

  /** Use an existing tab only if it is still opening or showing the requested page. */
  async reuseOpenTab(url, active) {
    const key = normalizeUrl(url);
    const tabs = await this.p.tabs.query({ windowType: 'normal' });
    const matches = (t) => t && normalizeUrl(t.pendingUrl || t.url || '') === key;
    const open = tabs.find(matches);
    if (!open || !active) return open || null;
    const selected = await this.p.tabs.update(open.id, { active: true });
    if (!matches(selected)) return null;
    const focused = await this.p.windows.update(selected.windowId, { focused: true });
    return focused ? selected : null;
  }

  /**
   * Session restore puts a tab back in its old window and group, which may be the Shelf or a
   * window you are not looking at. Bring it out of the Shelf and to the window you asked from.
   */
  async settleRestoredTab(tab, windowId) {
    const shelfIds = this.shelfGroupIds();
    const inShelf = shelfIds.has(tab.groupId);
    if (inShelf) await this.p.tabs.ungroup([tab.id]);
    const target = windowId ?? tab.windowId;
    if (inShelf || target !== tab.windowId) {
      const place = await this.placeNewTab({}, target);
      await this.p.tabs.move(tab.id, { windowId: target, index: place.index ?? -1 });
      await this.p.tabs.update(tab.id, { active: true });
    }
    return (await this.p.tabs.get(tab.id)) || tab;
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
    this.maybeIntroduce();
  }

  /** Entry point for tabs.onUpdated: bookkeeping in the queue, page work outside it. */
  async tabUpdated(tabId, change, tab) {
    const result = await this.dispatch('onTabUpdated', tabId, change, tab);
    if (result?.pageLoaded) this.spawn(() => this.pageLoaded(tabId));
  }

  async onTabUpdated(tabId, change, tab) {
    if (this.expectedRemovals.has(tabId)) return {}; // Ebb is closing it
    let rec = this.ensureRecord(tab);
    if (change.url) {
      const adopted = this.lateAdopt(tab, rec);
      if (adopted !== rec) {
        rec = adopted;
        delete rec.adopted;
        await this.settleAdopted(tab, rec);
      }
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
    if (rec && !isWindowClosing && rec.stage === 'shelved' && isWebUrl(rec.url)) {
      // Closed from the Shelf (perhaps the whole group at once): keep it in the Library.
      await this.addToLibrary(await this.libraryItem(rec, { reason: 'shelf-closed' }));
      await this.log({ type: 'archive', from: 'shelved', host: hostOf(rec.url), reason: 'shelf-closed' });
    }
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
          await this.addToLibrary(await this.libraryItem(entry.rec, { reason: 'window-closed' }));
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
  async onNavCommitted({ tabId, frameId, url, transitionType, sameDocument = false }) {
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
    // A new document starts without unsaved typing; a same-document change (pushState, #hash)
    // keeps whatever the page reported, since the page will not report it again.
    if (!sameDocument) rec.dirty = false;
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
    if (!(await this.closeSavedTab(tab, rec, { url }))) {
      await this.removeLater(item.id);
      return;
    }
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

  async openLater(id, { active = true, windowId, opener, intoTabId } = {}) {
    const item = await this.p.repo.get('later', id);
    if (!item) return null;
    let tab = await this.reuseOpenTab(item.url, active);
    if (!tab) {
      if (intoTabId != null) tab = await this.p.tabs.update(intoTabId, { url: item.url, active: true });
      if (!tab) {
        const props = opener
          ? { url: item.url, active, windowId: opener.windowId, index: opener.index + 1, openerTabId: opener.id }
          : await this.placeNewTab({ url: item.url, active }, windowId);
        tab = await this.createTab(props);
      }
      if (!tab) return null;
      const rec = this.ensureRecord(tab);
      if (item.source?.huntId && this.state.hunts[item.source.huntId]) {
        rec.huntId = item.source.huntId;
        rec.keepHuntOnce = true;
      }
      rec.restored = true;
      rec.fresh = false;
    }
    await this.removeLater(id);
    await this.log({ type: 'open-later', host: hostOf(item.url) });
    return tab;
  }

  async removeLater(id) {
    await this.p.repo.delete('later', id);
    this.state.counts.later = await this.p.repo.count('later');
    this.touch();
  }

  async expireLater(now) {
    const items = await this.p.repo.getAll('later');
    for (const item of items) {
      if (!isExpired(item, now, this.settings.laterExpireDays)) continue;
      await this.addToLibrary({
        id: this.p.id('lib'),
        url: item.url,
        key: normalizeUrl(item.url),
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
    this.state.counts.later = await this.p.repo.count('later');
    this.touch();
  }

  async sendTabToLater(tab) {
    if (!tab || !isWebUrl(tab.url) || tab.pinned) return null;
    const rec = this.ensureRecord(tab);
    if (tab.status === 'complete') await this.captureInto(tab, rec, 400);
    if (rec.dirty) return null;
    const item = await this.addLater({ url: tab.url, title: tab.title || rec.title, source: { url: '', title: '', huntId: rec.huntId || null } });
    if (!(await this.closeSavedTab(tab, rec, { individual: true }))) {
      await this.removeLater(item.id);
      return null;
    }
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
      if (await this.archiveTab(tab, rec, { reason: 'mission', batchId, type: 'tuck' })) count += 1;
    }
    if (!count) return { count };
    if (exceptTabId != null) {
      const receiptTab = await this.p.tabs.get(exceptTabId);
      if (receiptTab && isWebUrl(receiptTab.url)) {
        const rec = this.ensureRecord(receiptTab);
        await this.captureInto(receiptTab, rec, 700); // keeps the order number with the receipt
        await this.addToLibrary({ ...(await this.libraryItem(rec, { reason: 'receipt', batchId })), kind: 'receipt' });
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
      if (await this.archiveTab(tab, rec, { reason: 'fresh-start', batchId })) count += 1;
    }
    if (!count) return { count };
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
      if (await this.restoreItem(item.id, { unloaded: true, from: 'undo' })) count += 1;
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
      if (await this.restoreItem(item.id, { active: i === 0, unloaded: i > 0, from: 'resume' })) count += 1;
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
    const inUse = new Set(
      [
        ...Object.values(this.state.tabs),
        ...Object.values(this.state.limbo).flat().map((entry) => entry.rec),
        ...Object.values(this.state.startup?.prev || {}).flat(),
      ].map((rec) => normalizeUrl(rec.url)),
    );
    for (const snap of await this.p.repo.getAll('snapshots')) {
      if (!inUse.has(snap.id) && now - snap.at > DAY) await this.p.repo.delete('snapshots', snap.id);
    }
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
          const stopText = this.settings.captureText && !next.captureText;
          this.settings = next;
          if (stopText) {
            await this.p.repo.clear('snapshots');
            for (const rec of Object.values(this.state.tabs)) rec.excerptUrl = '';
          }
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
    const own = tab ? this.state.tabs[tab.id] : null;
    switch (action) {
      case 'tuck': {
        // Only the task of the page that showed the offer.
        if (!own?.huntId || own.huntId !== data.huntId) return { toast: { text: 'Nothing to tuck away.', timeoutMs: 3000 } };
        const { count, batchId } = await this.tuckHunt(data.huntId, tab.id);
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
        const items = data.batchId ? await this.p.repo.findBy('library', 'batchId', data.batchId) : [];
        if (!own?.huntId || !items.some((i) => i.huntId === own.huntId)) return { toast: { text: 'Nothing to bring back.', timeoutMs: 3000 } };
        const { count } = await this.undoBatch(data.batchId);
        return { toast: { text: `Brought back ${plural(count, 'tab')}.`, timeoutMs: 3000 } };
      }
      case 'show-shelf': {
        const shelfId = tab && this.state.shelf[tab.windowId];
        if (shelfId != null) await this.p.groups.update(shelfId, { collapsed: false });
        return { ok: true };
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
        return { ok: await this.shelve(tab, this.ensureRecord(tab), 'manual', { individual: true }) };
      }
      case 'archive-tab': {
        const tab = await this.p.tabs.get(msg.tabId);
        if (!tab || tab.pinned || !isWebUrl(tab.url)) return { ok: false };
        const item = await this.archiveTab(tab, this.ensureRecord(tab), { reason: 'manual' });
        return item ? { ok: true, id: item.id } : { ok: false, error: 'Ebb could not close this tab into the Library.' };
      }
      case 'keep-tab':
        return this.keepTab(msg.tabId, msg.mode ?? null);
      case 'later-tab': {
        const tab = await this.p.tabs.get(msg.tabId);
        const item = await this.sendTabToLater(tab);
        return item ? { ok: true, id: item.id } : { ok: false, error: 'Ebb could not send this tab to Later.' };
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

  // ---------------------------------------------------------------- address bar: "ebb <words>"

  async matchingLater(q) {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    return (await this.p.repo.getAll('later'))
      .filter((i) => !i.openedAt && terms.every((t) => `${i.title} ${i.url}`.toLowerCase().includes(t)))
      .sort((a, b) => b.savedAt - a.savedAt);
  }

  /** Suggestions while you type: Later links first, then Library pages, best matches first. */
  async omniboxSuggest(text) {
    const q = String(text || '').trim();
    if (!q) return [];
    const later = (await this.matchingLater(q))
      .slice(0, 2)
      .map((i) => ({ url: i.url, title: i.title, where: 'Later' }));
    const library = (await this.library({ q, limit: 8 })).items.map((i) => ({
      url: i.url,
      title: i.title,
      where: i.huntName && i.huntName !== 'Later' ? `Library · ${i.huntName}` : 'Library',
    }));
    const seen = new Set();
    const suggestions = [];
    for (const s of [...later, ...library]) {
      if (seen.has(s.url) || suggestions.length >= 6) continue;
      seen.add(s.url);
      suggestions.push({ content: s.url, description: `${xml(s.title)} <dim>· ${xml(s.where)}</dim> <url>${xml(prettyUrl(s.url))}</url>` });
    }
    return suggestions;
  }

  /**
   * Enter: open the chosen suggestion, or the best match for what you typed.
   * disposition is Chrome's: currentTab, newForegroundTab or newBackgroundTab.
   */
  async omniboxEnter(text, disposition = 'currentTab', current = null) {
    const q = String(text || '').trim();
    if (!q) return { ok: false };
    const laterItems = await this.matchingLater(q);
    const address = isWebUrl(q);
    const later = address ? laterItems.find((i) => i.url === q) : laterItems[0];
    let item = null;
    if (!later) {
      item = address ? await this.findLibraryItemByUrl(q) : (await this.library({ q, limit: 1 })).items[0];
    }
    const active = disposition !== 'newBackgroundTab';
    const intoTabId = disposition === 'currentTab' && current && !current.pinned ? current.id : undefined;
    const windowId = current?.windowId;
    if (later) return { ok: Boolean(await this.openLater(later.id, { active, intoTabId, windowId })) };
    if (item) return { ok: Boolean(await this.restoreItem(item.id, { active, intoTabId, windowId, from: 'search' })) };
    if (current) this.toast(current.id, { text: `Nothing in Ebb matches “${q}”.`, timeoutMs: 3000 });
    return { ok: false };
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
      else if (stage === 'shelved') stage = unloaded(tab) ? 'resting' : 'live';
      else if (unloaded(tab)) stage = 'resting';
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
      let added = 0;
      for (const item of items) {
        if (store === 'library') {
          const saved = await this.p.repo.get('library', item.id);
          if (saved) {
            const samePage = normalizeUrl(saved.url) === normalizeUrl(item.url);
            const sameKind = (saved.reason === 'receipt') === (item.reason === 'receipt');
            if (!samePage || !sameKind || saved.archivedAt >= item.archivedAt) continue;
          }
          if (!(await this.addToLibrary({ ...item }, { preferNewer: true }))) continue;
        } else {
          await this.p.repo.put(store, item);
        }
        added += 1;
      }
      counts[store] = added;
    }
    if (data.hunts && typeof data.hunts === 'object') {
      for (const [id, hunt] of Object.entries(data.hunts)) {
        if (!this.state.hunts[id] && hunt && typeof hunt === 'object' && hunt.id === id) this.state.hunts[id] = hunt;
      }
    }
    this.state.counts.later = await this.p.repo.count('later');
    this.touch();
    return { ok: true, counts };
  }
}
