// Wires the real engine to the fake browser through the same event wiring the extension uses,
// plus helpers that read like what a person does: open, click, browse for a while, step away.

import { Engine } from '../../extension/lib/engine.js';
import { wireEvents } from '../../extension/lib/wiring.js';
import { MIN, HOUR } from '../../extension/lib/util.js';
import { FakeBrowser } from './fake-browser.js';

export { FakeBrowser };

const tick = () => new Promise((resolve) => setImmediate(resolve));

export class Harness {
  constructor(browser) {
    this.browser = browser;
    this.engine = new Engine(browser.ports());
    wireEvents(this.engine, browser.api, { onError: (where, err) => browser.errors.push({ where, err }) });
  }

  /** Wait until every event has been delivered and the engine is idle. */
  async settle() {
    for (let i = 0; i < 500; i++) {
      await tick();
      await this.engine.idle();
      if (this.browser.pendingEvents === 0) {
        await tick();
        if (this.browser.pendingEvents === 0) {
          await this.engine.idle();
          if (this.browser.errors.length) throw this.browser.errors[0].err;
          return;
        }
      }
    }
    throw new Error('The fake browser never settled');
  }

  get state() {
    return this.engine.state;
  }

  rec(tabId) {
    return this.engine.state.tabs[tabId];
  }

  tab(tabId) {
    return this.browser.view(tabId);
  }

  hunt(tabId) {
    return this.engine.state.hunts[this.rec(tabId)?.huntId];
  }

  async open(url, options) {
    const id = this.browser.openTab(url, options);
    await this.settle();
    return id;
  }

  async background(sourceId, url, options) {
    const id = this.browser.openLinkInBackground(sourceId, url, options);
    await this.settle();
    return id;
  }

  async activate(tabId) {
    this.browser.activate(tabId);
    await this.settle();
  }

  async navigate(tabId, url, options) {
    this.browser.navigate(tabId, url, options);
    await this.settle();
  }

  async close(tabId) {
    this.browser.closeTab(tabId);
    await this.settle();
  }

  /** Browse for n minutes: wall time passes, the active clock runs, the minute alarm fires. */
  async use(minutes) {
    for (let i = 0; i < minutes; i++) {
      this.browser.time += MIN;
      this.browser.tick();
      await this.settle();
    }
  }

  /** Jump the active clock forward n minutes (one alarm tick instead of n). */
  async skip(minutes) {
    await this.engine.enqueue(async () => {
      await this.engine.load();
      this.engine.state.clock.activeMs += minutes * MIN;
      this.engine.touch();
    });
    await this.use(1);
  }

  /** A natural boundary: you step away from the keyboard. */
  async stepAway() {
    this.browser.idle('idle');
    await this.settle();
  }

  async comeBack() {
    this.browser.idle('active');
    await this.settle();
  }

  async message(msg, sender = {}) {
    const result = await this.engine.dispatch('onMessage', msg, sender);
    await this.settle();
    return result;
  }

  act(action, args = {}) {
    return this.message({ type: 'panel:do', action, ...args });
  }

  toastAction(tabId, action, data = {}) {
    return this.message({ type: 'ebb:toast-action', action, data }, { tab: this.tab(tabId) });
  }

  async items(store = 'library') {
    return this.browser.repo.getAll(store);
  }

  async events(type) {
    const all = await this.browser.repo.getAll('ledger');
    return type ? all.filter((e) => e.type === type) : all;
  }

  shelfTabs(windowId = this.browser.focusedWindow) {
    const groupId = this.engine.state.shelf[windowId];
    return this.browser.strip(windowId).filter((id) => this.browser.tabs.get(id).groupId === groupId);
  }
}

/** A fresh install in a browser with one empty window. */
export async function setup({ settings = {}, browser = new FakeBrowser() } = {}) {
  if (browser.focusedWindow == null) browser.openWindow();
  const t = new Harness(browser);
  await t.engine.dispatch('install', 'install');
  if (Object.keys(settings).length) await t.engine.dispatch('onMessage', { type: 'panel:settings', patch: settings });
  await t.settle();
  return t;
}

/** Start the engine on an existing browser without installing (a service worker restart). */
export async function connect(browser) {
  browser.detachAll();
  const t = new Harness(browser);
  await t.settle();
  return t;
}

/**
 * The next browser session after `previous`: same storage and Library, new tab ids, and the
 * given tabs already restored by Chrome before Ebb's service worker starts (so no events).
 */
export function nextSession(previous, { restore, after = 10 * HOUR, firstId = 500 } = {}) {
  const b = new FakeBrowser({ storage: previous.storageData, repo: previous.repo, firstId, now: previous.time + after });
  const windowId = b.openWindow();
  for (const { url, active = false } of restore) {
    const id = b.nextTabId++;
    b.tabs.set(id, {
      id, windowId, url, title: url, favIconUrl: '', active, pinned: false, audible: false, discarded: false,
      autoDiscardable: true, groupId: -1, status: 'complete', incognito: false, page: b.pageFor(url),
    });
    b.windows.get(windowId).order.push(id);
  }
  return b;
}
