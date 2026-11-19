// The engine's ports backed by real Chrome APIs. Calls that fail because a tab or group
// just went away resolve to null instead of throwing, which is what the engine expects.

import { openRepo } from './idb.js';

const quiet = (promise) => Promise.resolve(promise).then((v) => v ?? null, () => null);

/** Resolve with the page's answer, or null if there is no content script or it is too slow. */
function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    Promise.resolve(promise).then(
      (v) => {
        clearTimeout(timer);
        resolve(v ?? null);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

export function chromePorts() {
  let seq = 0;
  return {
    now: () => Date.now(),
    id: (prefix) => `${prefix}_${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    warn: (...args) => console.warn(...args),

    storage: {
      get: (keys) => chrome.storage.local.get(keys),
      set: (items) => chrome.storage.local.set(items),
    },
    // Cleared when the browser restarts (and when Ebb is reloaded): used to notice a new session.
    session: {
      get: async () => (await chrome.storage.session.get('ebb:session'))['ebb:session'] ?? null,
      set: () => chrome.storage.session.set({ 'ebb:session': Date.now() }),
    },

    tabs: {
      query: (q) => chrome.tabs.query(q),
      get: (id) => quiet(chrome.tabs.get(id)),
      create: (props) => quiet(chrome.tabs.create(props)),
      update: (id, props) => quiet(chrome.tabs.update(id, props)),
      move: (id, props) => quiet(chrome.tabs.move(id, props)),
      remove: (id) => chrome.tabs.remove(id).then(() => true, () => false),
      discard: (id) => quiet(chrome.tabs.discard(id)),
      group: (options) => chrome.tabs.group(options),
      ungroup: (ids) => quiet(chrome.tabs.ungroup(ids)),
      sendMessage: (id, msg, timeoutMs = 1000) => withTimeout(chrome.tabs.sendMessage(id, msg, { frameId: 0 }), timeoutMs),
    },
    groups: {
      get: (id) => quiet(chrome.tabGroups.get(id)),
      update: (id, props) => quiet(chrome.tabGroups.update(id, props)),
      move: (id, props) => quiet(chrome.tabGroups.move(id, props)),
      query: (q) => chrome.tabGroups.query(q),
    },
    windows: {
      getLastFocused: () => quiet(chrome.windows.getLastFocused({ windowTypes: ['normal'] })),
      update: (id, props) => quiet(chrome.windows.update(id, props)),
    },
    sessions: {
      getRecentlyClosed: (options) => chrome.sessions.getRecentlyClosed(options),
      restore: (sessionId) => chrome.sessions.restore(sessionId),
    },
    repo: openRepo(),
    action: {
      async setBadge(text, color) {
        await chrome.action.setBadgeText({ text });
        if (text) await chrome.action.setBadgeBackgroundColor({ color });
      },
    },
    notify(msg) {
      // Extension pages (the side panel) listen; nobody listening is fine.
      chrome.runtime.sendMessage(msg).catch(() => {});
    },
  };
}
