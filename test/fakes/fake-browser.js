// An in-memory stand-in for the Chrome APIs Ebb uses: windows, ordered tabs, tab groups,
// discarding, recently closed tabs, content-script replies, storage and events.
// Events are delivered asynchronously, like Chrome's, with snapshots of the tab.

const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const isWeb = (url) => /^https?:\/\//i.test(url || '');

class FakeEvent {
  constructor(browser) {
    this.browser = browser;
    this.listeners = [];
  }

  addListener(fn) {
    this.listeners.push(fn);
  }

  emit(...args) {
    const snapshot = args.map(clone);
    this.browser.pendingEvents += 1;
    setImmediate(() => {
      this.browser.pendingEvents -= 1;
      for (const fn of this.listeners) fn(...snapshot);
    });
  }
}

export function memoryRepo(stores = {}) {
  const store = (name) => (stores[name] ||= new Map());
  return {
    stores,
    put: async (name, value) => void store(name).set(value.id, clone(value)),
    get: async (name, key) => clone(store(name).get(key)) ?? null,
    getAll: async (name) => [...store(name).values()].map(clone),
    delete: async (name, key) => void store(name).delete(key),
    clear: async (name) => void store(name).clear(),
    count: async (name) => store(name).size,
    getAllSince: async (name, index, since) => [...store(name).values()].filter((v) => v[index] >= since).map(clone),
    deleteBefore: async (name, index, before) => {
      for (const [key, value] of store(name)) if (value[index] < before) store(name).delete(key);
    },
  };
}

export class FakeBrowser {
  constructor({ now = Date.UTC(2026, 10, 18, 9, 0, 0), storage = {}, repo = null, firstId = 1 } = {}) {
    this.time = now;
    this.seq = 0;
    this.nextTabId = firstId;
    this.nextWindowId = 1000 + firstId;
    this.nextGroupId = 5000 + firstId;
    this.windows = new Map(); // id -> { id, order: [tabId] }
    this.tabs = new Map(); // id -> live tab
    this.groups = new Map(); // id -> { id, windowId, title, color, collapsed }
    this.closed = []; // recently closed, newest first
    this.pages = new Map(); // url -> page model
    this.messages = []; // [{ tabId, msg }]
    this.toasts = []; // [{ tabId, toast }]
    this.restores = []; // [{ tabId, freeze }]
    this.notifications = [];
    this.warnings = [];
    this.errors = [];
    this.storageData = storage;
    this.sessionMarker = null;
    this.repo = repo || memoryRepo();
    this.badge = { text: '', color: null };
    this.pendingEvents = 0;
    this.focusedWindow = null;
    this.noDiscard = new Set();
    const ev = () => new FakeEvent(this);
    this.api = {
      tabs: { onCreated: ev(), onActivated: ev(), onUpdated: ev(), onRemoved: ev(), onReplaced: ev(), onAttached: ev() },
      tabGroups: { onRemoved: ev() },
      webNavigation: { onCommitted: ev(), onHistoryStateUpdated: ev(), onCreatedNavigationTarget: ev() },
      windows: { onFocusChanged: ev() },
      idle: { onStateChanged: ev() },
      alarms: { onAlarm: ev() },
    };
  }

  /** Forget every listener, as when a service worker stops and a new one starts. */
  detachAll() {
    for (const namespace of Object.values(this.api)) for (const event of Object.values(namespace)) event.listeners = [];
  }

  // ---------------------------------------------------------------- views

  indexOf(tabId) {
    const tab = this.tabs.get(tabId);
    return this.windows.get(tab.windowId).order.indexOf(tabId);
  }

  view(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return null;
    return clone({ ...tab, index: this.indexOf(tabId), page: undefined });
  }

  allViews() {
    const out = [];
    for (const w of this.windows.values()) for (const id of w.order) out.push(this.view(id));
    return out;
  }

  queryTabs(q = {}) {
    return this.allViews().filter((t) => {
      if (q.windowId != null && t.windowId !== q.windowId) return false;
      if (q.groupId != null && t.groupId !== q.groupId) return false;
      if (q.active != null && t.active !== q.active) return false;
      if (q.pinned != null && t.pinned !== q.pinned) return false;
      if (q.discarded != null && t.discarded !== q.discarded) return false;
      return true;
    });
  }

  /** Tab ids in strip order for a window, handy in assertions. */
  strip(windowId = this.focusedWindow) {
    return [...this.windows.get(windowId).order];
  }

  // ---------------------------------------------------------------- pages (what the content script answers)

  page(url, model) {
    this.pages.set(url, { title: model.title || url, ...model });
  }

  pageFor(url) {
    const base = this.pages.get(url) || {};
    return {
      title: base.title || (isWeb(url) ? new URL(url).hostname : url),
      headings: base.headings || [],
      hasReference: Boolean(base.hasReference),
      excerpt: base.excerpt || '',
      description: base.description || '',
      scrollY: 0,
      scrollRatio: 0,
      media: [],
      dirty: false,
      linkText: base.linkText || {},
    };
  }

  deliver(tabId, msg) {
    this.messages.push({ tabId, msg: clone(msg) });
    const tab = this.tabs.get(tabId);
    if (!tab || tab.discarded || !isWeb(tab.url) || tab.status !== 'complete' || tab.noContentScript) return null;
    const page = tab.page;
    switch (msg.type) {
      case 'ebb:capture': {
        const out = { scrollY: page.scrollY, scrollRatio: page.scrollRatio, title: tab.title, media: clone(page.media), dirty: page.dirty };
        if (msg.text) Object.assign(out, { excerpt: page.excerpt, description: page.description });
        return out;
      }
      case 'ebb:signals':
        return { title: tab.title, headings: clone(page.headings), hasReference: page.hasReference };
      case 'ebb:restore':
        this.restores.push({ tabId, freeze: clone(msg.freeze) });
        page.scrollY = msg.freeze?.scrollY ?? page.scrollY;
        return { ok: true };
      case 'ebb:link-info':
        return page.linkText[msg.url] ? { text: page.linkText[msg.url] } : null;
      case 'ebb:toast':
        this.toasts.push({ tabId, toast: clone(msg.toast) });
        return { ok: true };
      default:
        return null;
    }
  }

  // ---------------------------------------------------------------- user actions

  openWindow({ focused = true } = {}) {
    const id = this.nextWindowId++;
    this.windows.set(id, { id, order: [] });
    if (focused) this.focus(id);
    return id;
  }

  focus(windowId) {
    this.focusedWindow = windowId === -1 ? this.focusedWindow : windowId;
    this.api.windows.onFocusChanged.emit(windowId);
  }

  /** Open a tab the way a person would; returns its id. */
  openTab(url, { windowId = this.focusedWindow, active = true, opener = null, transition = 'typed', pinned = false, index = null } = {}) {
    const id = this.nextTabId++;
    const win = this.windows.get(windowId);
    const tab = {
      id,
      windowId,
      url: '',
      pendingUrl: url,
      title: '',
      favIconUrl: '',
      active: false,
      pinned,
      audible: false,
      discarded: false,
      groupId: -1,
      status: 'loading',
      incognito: false,
      openerTabId: opener ?? undefined,
      page: this.pageFor(url),
    };
    this.tabs.set(id, tab);
    let at = index ?? win.order.length;
    if (index == null && opener != null && this.tabs.get(opener)?.windowId === windowId) {
      at = this.indexOf(opener) + 1;
      while (at < win.order.length && this.tabs.get(win.order[at]).openerTabId === opener) at += 1;
    }
    win.order.splice(Math.min(at, win.order.length), 0, id);
    const neighbors = [this.tabs.get(win.order[at - 1]), this.tabs.get(win.order[at + 1])];
    if (neighbors[0] && neighbors[1] && neighbors[0].groupId !== -1 && neighbors[0].groupId === neighbors[1].groupId) tab.groupId = neighbors[0].groupId;
    this.api.tabs.onCreated.emit(this.view(id));
    if (active) this.activate(id);
    this.navigate(id, url, { transition });
    return id;
  }

  /** Middle-click (or Ctrl+click) on a link: a background tab opened from a page. */
  openLinkInBackground(sourceTabId, url, { linkText } = {}) {
    const source = this.tabs.get(sourceTabId);
    if (linkText) source.page.linkText[url] = linkText;
    // onCreated fires first, then onCreatedNavigationTarget, then the navigation.
    const tabId = this.openTabSilently(url, source.windowId, sourceTabId);
    this.api.webNavigation.onCreatedNavigationTarget.emit({ sourceTabId, sourceFrameId: 0, tabId, url, timeStamp: this.time });
    this.navigate(tabId, url, { transition: 'link' });
    return tabId;
  }

  openTabSilently(url, windowId, opener) {
    const id = this.nextTabId++;
    const win = this.windows.get(windowId);
    let at = this.indexOf(opener) + 1;
    while (at < win.order.length && this.tabs.get(win.order[at]).openerTabId === opener) at += 1;
    this.tabs.set(id, {
      id, windowId, url: '', pendingUrl: url, title: '', favIconUrl: '', active: false, pinned: false, audible: false,
      discarded: false, groupId: -1, status: 'loading', incognito: false, openerTabId: opener, page: this.pageFor(url),
    });
    win.order.splice(at, 0, id);
    this.api.tabs.onCreated.emit(this.view(id));
    return id;
  }

  navigate(tabId, url, { transition = 'link' } = {}) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    tab.url = url;
    tab.pendingUrl = undefined;
    tab.status = 'loading';
    tab.page = this.pageFor(url);
    this.api.tabs.onUpdated.emit(tabId, { status: 'loading', url }, this.view(tabId));
    this.api.webNavigation.onCommitted.emit({ tabId, frameId: 0, url, transitionType: transition, transitionQualifiers: [], timeStamp: this.time });
    this.finishLoad(tabId);
  }

  finishLoad(tabId) {
    const tab = this.tabs.get(tabId);
    tab.status = 'complete';
    tab.title = tab.page.title;
    this.api.tabs.onUpdated.emit(tabId, { title: tab.title }, this.view(tabId));
    this.api.tabs.onUpdated.emit(tabId, { status: 'complete' }, this.view(tabId));
  }

  activate(tabId) {
    const tab = this.tabs.get(tabId);
    for (const id of this.windows.get(tab.windowId).order) this.tabs.get(id).active = id === tabId;
    const group = this.groups.get(tab.groupId);
    if (group?.collapsed) group.collapsed = false; // Chrome expands a group when one of its tabs is selected
    this.api.tabs.onActivated.emit({ tabId, windowId: tab.windowId });
    if (tab.discarded) {
      tab.discarded = false;
      tab.page = this.pageFor(tab.url); // reloaded: the page starts at the top again
      tab.status = 'loading';
      this.api.tabs.onUpdated.emit(tabId, { discarded: false, status: 'loading' }, this.view(tabId));
      this.finishLoad(tabId);
    }
  }

  scroll(tabId, scrollY, scrollRatio = 0.5) {
    Object.assign(this.tabs.get(tabId).page, { scrollY, scrollRatio });
  }

  type(tabId, dirty = true) {
    this.tabs.get(tabId).page.dirty = dirty;
  }

  setAudible(tabId, audible = true) {
    this.tabs.get(tabId).audible = audible;
  }

  /** Close a tab like a person (or the engine) would. */
  closeTab(tabId, { isWindowClosing = false } = {}) {
    const tab = this.tabs.get(tabId);
    if (!tab) return null;
    const win = this.windows.get(tab.windowId);
    const index = this.indexOf(tabId);
    if (isWeb(tab.url)) {
      this.closed.unshift({ lastModified: Math.floor(this.time / 1000), tab: { sessionId: `s${++this.seq}`, url: tab.url, title: tab.title, windowId: tab.windowId, index } });
      this.closed = this.closed.slice(0, 25);
    }
    win.order.splice(index, 1);
    this.tabs.delete(tabId);
    this.dropEmptyGroup(tab.groupId);
    if (tab.active && !isWindowClosing && win.order.length) this.activate(win.order[Math.min(index, win.order.length - 1)]);
    this.api.tabs.onRemoved.emit(tabId, { windowId: tab.windowId, isWindowClosing });
    return true;
  }

  closeWindow(windowId) {
    for (const id of [...this.windows.get(windowId).order]) this.closeTab(id, { isWindowClosing: true });
    this.windows.delete(windowId);
    if (this.focusedWindow === windowId) {
      const next = [...this.windows.keys()][0] ?? null;
      this.focusedWindow = next;
      this.api.windows.onFocusChanged.emit(next ?? -1);
    }
  }

  idle(state) {
    this.api.idle.onStateChanged.emit(state);
  }

  tick() {
    this.api.alarms.onAlarm.emit({ name: 'ebb-tick', scheduledTime: this.time });
  }

  // ---------------------------------------------------------------- tab API

  createTabApi({ url, active = true, windowId, index, openerTabId }) {
    const win = this.windows.has(windowId) ? windowId : windowId == null ? this.focusedWindow : null;
    if (win == null) return null;
    const id = this.openTab(url, { windowId: win, active, transition: 'link', index: index ?? null, opener: openerTabId ?? null });
    return this.view(id);
  }

  updateTabApi(tabId, props) {
    if (!this.tabs.has(tabId)) return null;
    if (props.active) this.activate(tabId);
    if (props.url) this.navigate(tabId, props.url, { transition: 'link' });
    return this.view(tabId);
  }

  discardTab(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.active || tab.discarded || this.noDiscard.has(tabId)) return null;
    tab.discarded = true;
    this.api.tabs.onUpdated.emit(tabId, { discarded: true }, this.view(tabId));
    return this.view(tabId);
  }

  moveTab(tabId, index) {
    const tab = this.tabs.get(tabId);
    if (!tab) return null;
    const order = this.windows.get(tab.windowId).order;
    order.splice(order.indexOf(tabId), 1);
    const at = index < 0 || index > order.length ? order.length : index;
    order.splice(at, 0, tabId);
    const left = this.tabs.get(order[at - 1]);
    const right = this.tabs.get(order[at + 1]);
    let groupId = tab.groupId;
    if (left && right && left.groupId !== -1 && left.groupId === right.groupId) groupId = left.groupId;
    else if (groupId !== -1 && left?.groupId !== groupId && right?.groupId !== groupId) groupId = -1;
    if (groupId !== tab.groupId) this.setGroup(tab, groupId);
    return this.view(tabId);
  }

  setGroup(tab, groupId) {
    const old = tab.groupId;
    tab.groupId = groupId;
    this.api.tabs.onUpdated.emit(tab.id, { groupId }, this.view(tab.id));
    this.dropEmptyGroup(old);
  }

  dropEmptyGroup(groupId) {
    if (groupId === -1 || !this.groups.has(groupId)) return;
    if ([...this.tabs.values()].some((t) => t.groupId === groupId)) return;
    const group = this.groups.get(groupId);
    this.groups.delete(groupId);
    this.api.tabGroups.onRemoved.emit(clone(group));
  }

  groupTabs({ tabIds, groupId, createProperties }) {
    const ids = [].concat(tabIds);
    for (const id of ids) {
      const tab = this.tabs.get(id);
      if (!tab) throw new Error(`No tab with id: ${id}.`);
      if (tab.pinned) throw new Error('Cannot group pinned tabs.');
    }
    let group;
    if (groupId != null) {
      group = this.groups.get(groupId);
      if (!group) throw new Error(`No group with id: ${groupId}.`);
    } else {
      const windowId = createProperties?.windowId ?? this.tabs.get(ids[0]).windowId;
      group = { id: this.nextGroupId++, windowId, title: '', color: 'grey', collapsed: false };
      this.groups.set(group.id, group);
    }
    const order = this.windows.get(group.windowId).order;
    // A new group forms where its first tab is; tabs added later join at the group's end.
    const anchor = groupId == null ? order.indexOf(ids[0]) : -1;
    for (const id of ids) {
      const tab = this.tabs.get(id);
      order.splice(order.indexOf(id), 1);
      const members = order.filter((t) => this.tabs.get(t).groupId === group.id);
      const at = members.length ? order.indexOf(members[members.length - 1]) + 1 : anchor >= 0 ? anchor : order.length;
      order.splice(Math.min(at, order.length), 0, id);
      if (tab.groupId !== group.id) this.setGroup(tab, group.id);
    }
    return group.id;
  }

  ungroupTabs(tabIds) {
    for (const id of [].concat(tabIds)) {
      const tab = this.tabs.get(id);
      if (!tab || tab.groupId === -1) continue;
      const order = this.windows.get(tab.windowId).order;
      order.splice(order.indexOf(id), 1);
      const members = order.filter((t) => this.tabs.get(t).groupId === tab.groupId);
      const at = members.length ? order.indexOf(members[members.length - 1]) + 1 : order.length;
      order.splice(at, 0, id);
      this.setGroup(tab, -1);
    }
    return true;
  }

  moveGroup(groupId, index) {
    const group = this.groups.get(groupId);
    if (!group) return null;
    const order = this.windows.get(group.windowId).order;
    const members = order.filter((t) => this.tabs.get(t).groupId === groupId);
    const rest = order.filter((t) => this.tabs.get(t).groupId !== groupId);
    const at = index < 0 || index > rest.length ? rest.length : index;
    rest.splice(at, 0, ...members);
    order.splice(0, order.length, ...rest);
    return clone(group);
  }

  restoreSession(sessionId) {
    const i = this.closed.findIndex((s) => s.tab?.sessionId === sessionId);
    if (i < 0) throw new Error('No session');
    const [session] = this.closed.splice(i, 1);
    const windowId = this.windows.has(session.tab.windowId) ? session.tab.windowId : this.focusedWindow;
    const id = this.openTab(session.tab.url, { windowId, active: true, transition: 'reload', index: session.tab.index });
    return { lastModified: session.lastModified, tab: this.view(id) };
  }

  // ---------------------------------------------------------------- ports for the engine

  ports() {
    const b = this;
    const run = (fn) => async (...args) => fn(...args);
    return {
      flushDelayMs: 0,
      now: () => b.time,
      id: (prefix) => `${prefix}_${++b.seq}`,
      sleep: async () => {},
      warn: (...args) => b.warnings.push(args),
      storage: {
        get: async (keys) => Object.fromEntries([].concat(keys).filter((k) => k in b.storageData).map((k) => [k, clone(b.storageData[k])])),
        set: async (items) => void Object.assign(b.storageData, clone(items)),
      },
      session: {
        get: async () => b.sessionMarker,
        set: async () => {
          b.sessionMarker = b.time;
        },
      },
      tabs: {
        query: run((q) => b.queryTabs(q)),
        get: run((id) => b.view(id)),
        create: run((props) => b.createTabApi(props)),
        update: run((id, props) => b.updateTabApi(id, props)),
        move: run((id, props) => b.moveTab(id, props.index)),
        remove: run((id) => b.closeTab(id)),
        discard: run((id) => b.discardTab(id)),
        group: run((options) => b.groupTabs(options)),
        ungroup: run((ids) => b.ungroupTabs(ids)),
        sendMessage: run((id, msg) => b.deliver(id, msg)),
      },
      groups: {
        get: run((id) => clone(b.groups.get(id)) ?? null),
        update: run((id, props) => {
          const g = b.groups.get(id);
          if (!g) return null;
          Object.assign(g, props);
          return clone(g);
        }),
        move: run((id, props) => b.moveGroup(id, props.index)),
        query: run((q = {}) => [...b.groups.values()].filter((g) => (q.windowId == null || g.windowId === q.windowId) && (q.title == null || g.title === q.title)).map(clone)),
      },
      windows: {
        getLastFocused: run(() => (b.focusedWindow == null ? null : { id: b.focusedWindow, focused: true, type: 'normal' })),
        update: run((id, props) => {
          if (props.focused && b.windows.has(id)) b.focus(id);
          return { id };
        }),
      },
      sessions: {
        getRecentlyClosed: run(({ maxResults = 25 } = {}) => clone(b.closed.slice(0, maxResults))),
        restore: run((sessionId) => b.restoreSession(sessionId)),
      },
      repo: b.repo,
      action: {
        setBadge: run((text, color) => {
          b.badge = { text, color };
        }),
      },
      notify: (msg) => b.notifications.push(msg),
    };
  }
}
