// Ebb's service worker: connects browser events, menus, shortcuts and messages to the engine.

import { Engine, TICK_MINUTES } from './lib/engine.js';
import { chromePorts } from './lib/chrome-ports.js';
import { wireEvents, TICK_ALARM } from './lib/wiring.js';

const engine = new Engine(chromePorts());
globalThis.ebb = { engine }; // handy in the service worker console; the smoke test uses it too

const run = wireEvents(engine, chrome, { onError: (where, err) => console.warn(`Ebb: ${where} failed`, err) });

chrome.idle.setDetectionInterval(60);
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
ensureAlarm();

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  setupMenus();
  await ensureAlarm();
  const result = await run('install', reason);
  if (result?.webTabIds?.length) await injectContentScript(result.webTabIds);
  if (reason === 'install') await chrome.tabs.create({ url: chrome.runtime.getURL('welcome/index.html') });
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  run('startup');
});

async function ensureAlarm() {
  if (!(await chrome.alarms.get(TICK_ALARM))) {
    await chrome.alarms.create(TICK_ALARM, { periodInMinutes: TICK_MINUTES, delayInMinutes: TICK_MINUTES });
  }
}

/** Pages that were already open when Ebb was installed or updated don't have its content script. */
async function injectContentScript(tabIds) {
  for (let i = 0; i < tabIds.length; i += 8) {
    await Promise.all(
      tabIds.slice(i, i + 8).map((tabId) =>
        chrome.scripting.executeScript({ target: { tabId }, files: ['content/content.js'] }).catch(() => {}),
      ),
    );
  }
}

// ---------------------------------------------------------------- context menus

const MENU = { linkLater: 'ebb-link-later', tabLater: 'ebb-tab-later', keep: 'ebb-keep' };
const WEB = ['http://*/*', 'https://*/*'];

function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU.linkLater, title: 'Save link to Later', contexts: ['link'], targetUrlPatterns: WEB });
    chrome.contextMenus.create({ id: MENU.tabLater, title: 'Send this tab to Later', contexts: ['page'], documentUrlPatterns: WEB });
    chrome.contextMenus.create({ id: MENU.keep, title: 'Keep this tab for a week', contexts: ['page'], documentUrlPatterns: WEB });
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU.linkLater) run('saveLinkToLater', info.linkUrl, tab);
  else if (info.menuItemId === MENU.tabLater && tab) run('sendTabToLater', tab);
  else if (info.menuItemId === MENU.keep && tab) run('keepFromPage', tab.id, 'week');
});

// ---------------------------------------------------------------- keyboard shortcuts

chrome.commands.onCommand.addListener(async (command, tab) => {
  tab ||= (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (!tab) return;
  if (command === 'keep-tab') run('keepFromPage', tab.id, 'toggle');
  else if (command === 'send-to-later') run('sendTabToLater', tab);
});

// ---------------------------------------------------------------- messages

const OWN_PAGES = chrome.runtime.getURL('');
const FROM_CONTENT = new Set(['ebb:dirty', 'ebb:toast-action']);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || sender.id !== chrome.runtime.id) return false;
  const fromOwnPage = typeof sender.url === 'string' && sender.url.startsWith(OWN_PAGES);
  const fromContent = Boolean(sender.tab) && !fromOwnPage && sender.frameId === 0;
  const allowed = msg.type.startsWith('panel:') ? fromOwnPage : FROM_CONTENT.has(msg.type) && fromContent;
  if (!allowed) return false;
  engine.dispatch('onMessage', msg, { tab: sender.tab }).then(
    (res) => sendResponse(res ?? { ok: true }),
    (err) => sendResponse({ ok: false, error: String(err?.message || err) }),
  );
  return true;
});
