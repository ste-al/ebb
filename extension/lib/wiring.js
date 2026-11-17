// Browser events -> engine. Shared by the service worker and the tests, so the tests
// exercise the same event filtering the extension uses.

export const TICK_ALARM = 'ebb-tick';

// tabs.onUpdated fires for every favicon, title and audio change; only these matter to Ebb.
const RELEVANT_CHANGES = ['url', 'title', 'favIconUrl', 'groupId', 'discarded'];

/**
 * @param {import('./engine.js').Engine} engine
 * @param {object} api  `chrome`, or an object with the same event objects (tests)
 * @returns {(method: string, ...args: any[]) => Promise<any>} a dispatcher that logs failures
 */
export function wireEvents(engine, api, { onError = () => {} } = {}) {
  const run = (method, ...args) => engine.dispatch(method, ...args).catch((err) => onError(method, err));

  api.tabs.onCreated.addListener((tab) => run('onTabCreated', tab));
  api.tabs.onActivated.addListener((info) => run('onTabActivated', info));
  api.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (change.status !== 'complete' && !RELEVANT_CHANGES.some((key) => key in change)) return;
    engine.tabUpdated(tabId, change, tab).catch((err) => onError('onTabUpdated', err));
  });
  api.tabs.onRemoved.addListener((tabId, info) => run('onTabRemoved', tabId, info));
  api.tabs.onReplaced.addListener((added, removed) => run('onTabReplaced', added, removed));
  api.tabs.onAttached.addListener((tabId, info) => run('onTabAttached', tabId, info));
  api.tabGroups.onRemoved.addListener((group) => run('onGroupRemoved', group));

  api.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId === 0) run('onNavCommitted', details);
  });
  // Single-page apps change URL without a load; treat that like a navigation that just finished.
  api.webNavigation.onHistoryStateUpdated.addListener((details) => {
    if (details.frameId !== 0) return;
    run('onNavCommitted', details).then(() => engine.spawn(() => engine.pageLoaded(details.tabId)));
  });
  api.webNavigation.onCreatedNavigationTarget.addListener((details) => run('onNavCreatedTarget', details));

  api.windows.onFocusChanged.addListener((windowId) => run('onFocus', windowId));
  api.idle.onStateChanged.addListener((state) => run('onIdle', state));
  api.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === TICK_ALARM) run('tick');
  });
  return run;
}
