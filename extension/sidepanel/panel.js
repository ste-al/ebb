// Ebb's side panel. It renders the engine's view model and sends every action back to the
// service worker. Page titles and URLs are always set as text, never parsed as HTML.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const $ = (selector, root = document) => root.querySelector(selector);
const send = (msg) => chrome.runtime.sendMessage(msg);
const act = (action, args = {}) => send({ type: 'panel:do', action, windowId: currentWindowId ?? undefined, ...args });

let currentWindowId = null;
let state = null;
let view = 'now';
const library = { q: '', limit: 60, items: [], total: 0 };

// ---------------------------------------------------------------- tiny DOM helpers

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const ICONS = {
  keep: ['M7 3.5h10v17l-5-3.8-5 3.8z'],
  shelf: ['M3.5 13.5h5l1.5 2.5h4l1.5-2.5h5', 'M5.5 5h13l2 8.5V19h-17v-5.5z'],
  later: ['circle:12,12,8.5', 'M12 7.5V12l3 2'],
  library: ['M3.5 4.5h17v4h-17z', 'M5 8.5v11h14v-11', 'M10 12.5h4'],
  close: ['M6.5 6.5l11 11', 'M17.5 6.5l-11 11'],
  search: ['circle:11,11,6.5', 'M20 20l-4.2-4.2'],
  site: ['circle:12,12,8.5', 'M3.5 12h17', 'M12 3.5c2.6 2.6 2.6 14.4 0 17', 'M12 3.5c-2.6 2.6-2.6 14.4 0 17'],
  done: ['M5 12.5l4.5 4.5L19 7'],
  undo: ['M9 14.5L4.5 10 9 5.5', 'M4.5 10H14a5.5 5.5 0 0 1 0 11h-3'],
  trash: ['M4.5 7h15', 'M9.5 7V4.5h5V7', 'M6.5 7l1 12.5h9l1-12.5'],
  pause: ['M9 5.5v13', 'M15 5.5v13'],
  wave: ['M3 13c2.5 0 2.5-3 5-3s2.5 3 5 3 2.5-3 5-3 2.5 3 3 3'],
};

function icon(name, size = 16) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({
    viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor',
    'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'icon',
  })) svg.setAttribute(k, String(v));
  for (const d of ICONS[name] || []) {
    if (d.startsWith('circle:')) {
      const [cx, cy, r] = d.slice(7).split(',');
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', cx);
      c.setAttribute('cy', cy);
      c.setAttribute('r', r);
      svg.append(c);
    } else {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      svg.append(p);
    }
  }
  return svg;
}

const iconButton = (name, label, onClick, extra = {}) =>
  h('button', { type: 'button', class: 'icon-btn', title: label, 'aria-label': label, onClick, ...extra }, icon(name));

function favicon(url) {
  const src = new URL(chrome.runtime.getURL('/_favicon/'));
  src.searchParams.set('pageUrl', url || 'about:blank');
  src.searchParams.set('size', '32');
  return h('img', { class: 'favicon', src: src.href, alt: '', loading: 'lazy' });
}

function empty(title, text) {
  return h('div', { class: 'empty' }, h('strong', { text: title }), text ? h('p', { text }) : null);
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function span(ms) {
  if (ms < MIN) return 'under a minute';
  if (ms < HOUR) return `${Math.round(ms / MIN)}m`;
  if (ms < DAY) return `${Math.round(ms / HOUR)}h`;
  return `${Math.round(ms / DAY)}d`;
}

const ago = (ts) => (state.now - ts < MIN ? 'just now' : `${span(state.now - ts)} ago`);
const shortDate = (ts) => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

let noticeTimer = null;
/** A short message at the bottom of the panel, optionally with one action such as Undo. */
function notice(text, action = null) {
  const el = $('#notice');
  el.replaceChildren(h('span', { text }));
  if (action) {
    el.append(
      h('button', { type: 'button', class: 'link notice-action', onClick: () => {
        el.hidden = true;
        action.run();
      } }, action.label),
    );
  }
  el.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    el.hidden = true;
  }, action ? 7000 : 4000);
}

/** Run an action, report errors, then refresh. `message` may be text, or a function of the result returning text or [text, action]. */
async function run(promise, message) {
  try {
    const res = await promise;
    if (res && res.ok === false && res.error) notice(res.error);
    else if (message) {
      const shown = typeof message === 'function' ? message(res) : message;
      if (Array.isArray(shown)) notice(...shown);
      else if (shown) notice(shown);
    }
  } catch (err) {
    notice(String(err?.message || err));
  }
  await refresh();
}

// ---------------------------------------------------------------- data

let refreshing = false;
let refreshAgain = false;
let refreshTimer = null;

async function refresh() {
  if (refreshing) {
    refreshAgain = true;
    return;
  }
  refreshing = true;
  try {
    state = await send({ type: 'panel:state', windowId: currentWindowId ?? undefined });
    if (state) {
      render();
      if (view === 'library') await loadLibrary();
    }
  } catch (err) {
    console.warn('Ebb panel: refresh failed', err);
  } finally {
    refreshing = false;
    if (refreshAgain) {
      refreshAgain = false;
      refresh();
    }
  }
}

function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 150);
}

async function setSetting(patch) {
  try {
    const settings = await send({ type: 'panel:settings', patch });
    if (state && settings) state.settings = settings;
  } catch (err) {
    notice(String(err?.message || err));
  }
  await refresh();
}

// ---------------------------------------------------------------- rendering

function render() {
  const t = state.totals || {};
  const parts = [`${t.live || 0} open`];
  if (t.resting) parts.push(`${t.resting} resting`);
  if (t.shelved) parts.push(`${t.shelved} on the Shelf`);
  parts.push(`${state.libraryCount} in the Library`);
  $('#summary').textContent = parts.join(' · ');
  $('#summary').title = `Active browsing time counted so far: ${span(state.activeMinutes * MIN)}`;
  const pause = $('#pause');
  pause.setAttribute('aria-pressed', String(state.settings.paused));
  pause.textContent = state.settings.paused ? 'Paused' : 'Pause';
  $('#later-count').textContent = state.later.length ? String(state.later.length) : '';
  renderBanners();
  if (view === 'now') renderNow();
  if (view === 'later') renderLater();
  if (view === 'ledger') renderLedger();
  syncSettings();
}

function renderBanners() {
  const root = $('#banners');
  root.replaceChildren();
  if (state.settings.paused) {
    root.append(
      h('div', { class: 'banner paused' }, icon('pause'), h('span', { text: 'Ebb is paused. Nothing will be tidied.' }),
        h('button', { type: 'button', class: 'link', onClick: () => setSetting({ paused: false }) }, 'Resume')),
    );
  }
  if (state.resume) root.append(resumeCard(state.resume));
  if (state.lastBatch) {
    const b = state.lastBatch;
    root.append(
      h('div', { class: 'banner batch' }, h('span', { text: b.label }),
        h('button', { type: 'button', class: 'small-btn ghost', onClick: () => run(act('undo', { batchId: b.id }), (r) => `Brought back ${plural(r?.count || 0, 'tab')}.`) }, icon('undo', 14), 'Undo'),
        iconButton('close', 'Dismiss', () => run(act('dismiss-batch')))),
    );
  }
}

function resumeCard(resume) {
  return h('div', { class: 'banner resume' },
    h('div', { class: 'banner-head' }, icon('wave'), h('strong', { text: 'Welcome back' })),
    h('p', { class: 'muted', text: 'You were in the middle of these. Focus on one and Ebb shelves the rest; nothing reloads until you need it.' }),
    h('ul', { class: 'resume-list' },
      resume.hunts.map((r) =>
        h('li', {},
          h('span', { class: 'resume-text' },
            h('span', { class: 'resume-name', text: r.name, title: r.name }),
            h('span', { class: 'muted small', text: [r.open ? `${r.open} open` : '', r.closed ? `${r.closed} closed` : ''].filter(Boolean).join(' · ') })),
          r.open ? h('button', { type: 'button', class: 'small-btn', onClick: () => run(act('focus-hunt', { huntId: r.huntId }), (res) => `Shelved ${plural(res?.count || 0, 'other tab')}.`) }, 'Focus') : null,
          r.closed ? h('button', { type: 'button', class: 'small-btn ghost', onClick: () => run(act('reopen-hunt', { huntId: r.huntId })) }, 'Reopen') : null,
        ),
      ),
    ),
    h('button', { type: 'button', class: 'link', onClick: () => run(act('dismiss-resume')) }, 'Keep everything as it is'),
  );
}

// ---------------------------------------------------------------- Now

const PROTECTED = {
  pinned: 'pinned',
  playing: 'playing sound',
  'kept active': 'kept loaded by Chrome',
  kept: 'kept',
  'unsaved input': 'unsaved typing',
  app: 'web app, never tidied',
  'exempt site': 'never tidied',
  'not a web page': '',
};

function nextLabel(next) {
  if (!next) return '';
  const when = span(next.inMs);
  if (next.stage === 'resting') return `unloads in ${when}`;
  if (next.stage === 'shelved') return `Shelf in ${when}`;
  return `Library in ${when}`;
}

function statusOf(t) {
  if (t.active) return 'you are here';
  if (t.protected === 'kept for now') return `kept until ${shortDate(t.keepUntil)}`;
  if (t.protected) return PROTECTED[t.protected] ?? t.protected;
  if (t.grouped && t.stage === 'resting') return 'resting in your group';
  if (t.stage === 'shelved') return nextLabel(t.next); // listed under “On the Shelf” already
  if (t.stage === 'resting') return t.next ? `resting · ${nextLabel(t.next)}` : 'resting';
  return nextLabel(t.next);
}

function tabRow(t) {
  const kept = Boolean(t.keep || t.keepUntil > state.now);
  const status = statusOf(t);
  return h('li', { class: `row stage-${t.stage}${t.active ? ' is-active' : ''}` },
    h('button', { type: 'button', class: 'row-main', title: `${t.title}\n${t.url}`, onClick: () => run(act('activate-tab', { tabId: t.tabId })) },
      favicon(t.url),
      h('span', { class: 'row-text' },
        h('span', { class: 'row-title', text: t.title }),
        h('span', { class: 'row-meta', title: status && !t.protected ? 'Counted in active browsing time' : null },
          h('span', { class: 'dot', 'aria-hidden': 'true' }),
          h('span', { class: 'meta-text', text: [t.host, status].filter(Boolean).join(' · ') })),
      ),
    ),
    h('div', { class: 'actions' },
      t.pinned ? null : iconButton('keep', kept ? 'Stop keeping this tab' : 'Keep this tab for a week', () => run(act('keep-tab', { tabId: t.tabId, mode: kept ? null : 'week' })), { 'aria-pressed': String(kept) }),
      t.active || t.pinned || t.stage === 'shelved' || !/^https?:/.test(t.url) ? null : iconButton('shelf', 'Move to the Shelf', () => run(act('shelve-tab', { tabId: t.tabId }))),
      t.pinned || !/^https?:/.test(t.url)
        ? null
        : iconButton('later', 'Send to Later', () =>
            run(act('later-tab', { tabId: t.tabId }), (r) =>
              r?.id ? ['Sent to Later.', { label: 'Undo', run: () => run(act('open-later', { id: r.id })) }] : null,
            ),
          ),
      t.pinned || !/^https?:/.test(t.url)
        ? null
        : iconButton('library', 'Close into the Library', () =>
            run(act('archive-tab', { tabId: t.tabId }), (r) =>
              r?.id ? ['Closed into the Library.', { label: 'Undo', run: () => run(act('restore-item', { id: r.id })) }] : null,
            ),
          ),
    ),
  );
}

function huntBlock(hunt) {
  const counts = [];
  if (hunt.counts.live) counts.push(`${hunt.counts.live} open`);
  if (hunt.counts.resting) counts.push(`${hunt.counts.resting} resting`);
  if (hunt.counts.shelved) counts.push(`${hunt.counts.shelved} on the Shelf`);
  const inView = hunt.tabs.filter((t) => t.stage !== 'shelved');
  const shelved = hunt.tabs.filter((t) => t.stage === 'shelved');
  const actions = hunt.id
    ? [
        inView.some((t) => !t.active)
          ? iconButton('shelf', 'Shelve this task’s tabs', () => run(act('shelve-hunt', { huntId: hunt.id }), (r) => `Shelved ${plural(r?.count || 0, 'tab')}.`))
          : null,
        iconButton('done', 'Done: tuck this task’s tabs into the Library', () => run(act('tuck-hunt', { huntId: hunt.id }))),
      ]
    : [];
  return h('section', { class: 'hunt' },
    h('header', { class: 'hunt-head' },
      icon(hunt.origin === 'search' ? 'search' : 'site'),
      h('div', { class: 'hunt-title' }, h('strong', { text: hunt.name, title: hunt.name }), h('span', { text: counts.join(' · ') })),
      h('div', { class: 'actions' }, actions),
    ),
    inView.length ? h('ul', { class: 'rows' }, inView.map(tabRow)) : null,
    shelved.length
      ? h('details', { class: 'shelved-rows' }, h('summary', { text: `On the Shelf · ${shelved.length}` }), h('ul', { class: 'rows' }, shelved.map(tabRow)))
      : null,
  );
}

function windowBlock(w, many) {
  const blocks = [];
  if (w.steady.length) {
    blocks.push(
      h('details', { class: 'steady' },
        h('summary', {}, h('strong', { text: `Always here · ${w.steady.length}` }), h('span', { text: '  pinned, apps and kept tabs' })),
        h('ul', { class: 'rows' }, w.steady.map(tabRow))),
    );
  }
  for (const hunt of w.hunts) blocks.push(huntBlock(hunt));
  if (!many) return blocks;
  const count = w.steady.length + w.hunts.reduce((n, hunt) => n + hunt.tabs.length, 0);
  return h('details', { class: 'window', open: w.current },
    h('summary', {}, w.current ? 'This window' : 'Another window', h('span', { class: 'muted', text: ` · ${plural(count, 'tab')}` })),
    blocks);
}

function renderNow() {
  const root = $('#view-now');
  const scroll = document.scrollingElement.scrollTop;
  const openDetails = new Set([...root.querySelectorAll('details[open]')].map((d) => d.dataset.key));
  root.replaceChildren();
  if (!state.windows.length) {
    root.append(empty('No tabs to show.'));
    return;
  }
  const many = state.windows.length > 1;
  for (const w of state.windows) root.append(...[windowBlock(w, many)].flat());
  // Keep disclosure state and scroll position across live refreshes.
  for (const [i, d] of [...root.querySelectorAll('details')].entries()) {
    const summary = d.querySelector('summary')?.textContent || '';
    d.dataset.key = `${i}:${summary.replace(/\d+/g, '')}`;
    if (openDetails.has(d.dataset.key)) d.open = true;
  }
  document.scrollingElement.scrollTop = scroll;
}

// ---------------------------------------------------------------- Later

function renderLater() {
  const root = $('#view-later');
  root.replaceChildren();
  if (!state.later.length) {
    root.append(
      empty('Nothing waiting.',
        'When one page opens more background tabs than you can read, the extra links wait here instead of piling up. You can also right-click any link and choose “Save link to Later”.'),
    );
    return;
  }
  root.append(
    h('ul', { class: 'rows lib-list' },
      state.later.map((item) =>
        h('li', { class: 'row' },
          h('button', { type: 'button', class: 'row-main', title: item.url, onClick: () => run(act('open-later', { id: item.id })) },
            favicon(item.url),
            h('span', { class: 'row-text' },
              h('span', { class: 'row-title', text: item.title }),
              h('span', { class: 'row-meta', text: [hostOf(item.url), ago(item.savedAt), item.source?.title ? `from ${item.source.title}` : ''].filter(Boolean).join(' · ') }),
            ),
          ),
          h('div', { class: 'actions' }, iconButton('close', 'Remove from Later', () => run(act('remove-later', { id: item.id })))),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------- Library

const REASONS = {
  idle: 'tidied after a long rest',
  budget: 'tidied to keep the window light',
  mission: 'task done',
  receipt: 'receipt',
  'session-end': 'didn’t come back after a restart',
  'window-closed': 'its window was closed',
  'fresh-start': 'fresh start',
  'later-expired': 'unread in Later',
  'shelf-closed': 'closed from the Shelf',
  manual: 'you closed it here',
};

async function loadLibrary() {
  try {
    const res = await send({ type: 'panel:library', q: library.q, limit: library.limit, offset: 0 });
    library.items = res?.items || [];
    library.total = res?.total || 0;
  } catch (err) {
    notice(String(err?.message || err));
  }
  renderLibrary();
}

function renderLibrary() {
  const list = $('#library-list');
  list.replaceChildren();
  if (!library.items.length) {
    list.append(
      library.q
        ? empty('No matches.', 'Ebb searches titles, addresses and the snippet of text it kept from each page.')
        : empty('The Library is empty.', 'Tabs Ebb tidies away end up here, with where you were on the page. Click one to bring it back.'),
    );
    return;
  }
  list.append(
    h('ul', { class: 'rows lib-list' },
      library.items.map((item) =>
        h('li', { class: 'row' },
          h('button', { type: 'button', class: 'row-main', title: item.url, onClick: () => run(act('restore-item', { id: item.id })) },
            favicon(item.url),
            h('span', { class: 'row-text' },
              h('span', { class: 'row-title', text: item.title }),
              h('span', { class: 'row-meta', text: [hostOf(item.url), shortDate(item.archivedAt), REASONS[item.reason] || item.reason].filter(Boolean).join(' · ') }),
              item.excerpt ? h('span', { class: 'row-excerpt', text: item.excerpt }) : null,
            ),
          ),
          h('div', { class: 'actions' }, iconButton('trash', 'Delete from the Library', () => run(act('delete-item', { id: item.id })))),
        ),
      ),
    ),
  );
  if (library.total > library.items.length) {
    list.append(
      h('button', { type: 'button', class: 'more', onClick: () => { library.limit += 60; loadLibrary(); } }, `Show more (${library.total - library.items.length})`),
    );
  }
}

// ---------------------------------------------------------------- Ledger

function renderLedger() {
  const root = $('#view-ledger');
  const w = state.ledger.week;
  const stat = (label, value) => h('div', {}, h('dt', { text: label }), h('dd', { text: String(value) }));
  const hosts = Object.entries(state.ledger.hostMult || {}).sort((a, b) => b[1] - a[1]);
  root.replaceChildren(
    h('p', { class: 'ledger-sentence', text: state.ledger.sentence }),
    h('h2', { text: 'Last 7 days' }),
    h('dl', { class: 'stats' },
      stat('Tidied away', w.tidied),
      stat('Brought back', w.restored),
      stat('Regret rate', `${Math.round(w.rate * 1000) / 10}%`),
      stat('Unloaded', w.rested),
      stat('Tasks tucked', w.tucked),
      stat('Links to Later', w.queued),
      stat('Later opened', w.openedLater),
    ),
    hosts.length ? h('h2', { text: 'Sites you bring back often' }) : null,
    hosts.length
      ? h('ul', { class: 'hosts' }, hosts.map(([host, m]) => h('li', {}, h('span', { text: host }), h('span', { class: 'muted', text: `tabs last ${m}× longer` }))))
      : null,
    h('p', { class: 'muted small', text: 'Ebb counts every tab it moves and every one you bring back. Sites you often bring back automatically get longer before Ebb tidies them.' }),
  );
}

// ---------------------------------------------------------------- Settings

const controls = new Map();

function settingRow(label, help, control, { stack = false } = {}) {
  return h('div', { class: `setting${stack ? ' stack' : ''}` }, h('label', { class: 'label', for: control.id }, h('strong', { text: label }), help ? h('span', { text: help }) : null), control);
}

function checkbox(key, label, help) {
  const input = h('input', { type: 'checkbox', id: `s-${key}`, onChange: (e) => setSetting({ [key]: e.target.checked }) });
  controls.set(key, (v) => { input.checked = Boolean(v); });
  return h('div', { class: 'setting' }, input, h('label', { class: 'label', for: input.id }, h('strong', { text: label }), help ? h('span', { text: help }) : null));
}

function number(key, label, help, min, max) {
  const input = h('input', { type: 'number', id: `s-${key}`, min, max, step: 1, inputmode: 'numeric', onChange: (e) => setSetting({ [key]: e.target.value }) });
  controls.set(key, (v) => { input.value = String(v); });
  return settingRow(label, help, input);
}

function select(key, label, help, options) {
  const input = h('select', { id: `s-${key}`, onChange: (e) => setSetting({ [key]: e.target.value }) }, options.map(([value, text]) => h('option', { value, text })));
  controls.set(key, (v) => { input.value = v; });
  return settingRow(label, help, input, { stack: true });
}

function radios(key, label, options) {
  const inputs = options.map(([value, text, help]) =>
    h('label', {}, h('input', { type: 'radio', name: `s-${key}`, value, onChange: () => setSetting({ [key]: value }) }), h('strong', { text }), h('span', { text: help })),
  );
  controls.set(key, (v) => { for (const l of inputs) l.querySelector('input').checked = l.querySelector('input').value === v; });
  return h('div', { class: 'setting stack' }, h('div', { class: 'label' }, h('strong', { text: label })), h('div', { class: 'radios', role: 'radiogroup', 'aria-label': label }, inputs));
}

function hostList(key, label, help) {
  const input = h('textarea', { id: `s-${key}`, spellcheck: 'false', placeholder: 'example.com', onChange: (e) => setSetting({ [key]: e.target.value.split(/[\s,]+/).filter(Boolean) }) });
  controls.set(key, (v) => { input.value = (v || []).join('\n'); });
  return settingRow(label, help, input, { stack: true });
}

function confirmable(label, question, yes, onYes, cls = 'btn ghost') {
  const wrap = h('div', { class: 'confirm', hidden: true });
  const button = h('button', { type: 'button', class: cls, onClick: () => { wrap.hidden = false; button.hidden = true; } }, label);
  const close = () => { wrap.hidden = true; button.hidden = false; };
  wrap.append(
    h('p', { text: question }),
    h('button', { type: 'button', class: 'btn', onClick: () => { close(); onYes(); } }, yes),
    h('button', { type: 'button', class: 'btn ghost', onClick: close }, 'Cancel'),
  );
  return { button, wrap };
}

function buildSettings() {
  const fresh = confirmable('Fresh start…',
    'Move every tab that isn’t pinned, kept, playing, a web app or in one of your groups into the Library? One click on Undo brings them all back.',
    'Move them',
    () => run(act('fresh-start'), (r) => `Moved ${plural(r?.count || 0, 'tab')} to the Library.`));
  const clear = confirmable('Clear the Library…', 'Delete everything in the Library? This can’t be undone.', 'Delete all', () => run(act('clear-library'), 'Library cleared.'), 'btn danger');
  const importInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onChange: importFile });

  $('#view-settings').replaceChildren(
    h('div', { class: 'group' },
      checkbox('paused', 'Pause Ebb', 'Nothing is unloaded, shelved or closed while paused.'),
      radios('pace', 'Pace', [
        ['gentle', 'Gentle', 'tabs stay twice as long'],
        ['balanced', 'Balanced', 'the default'],
        ['brisk', 'Brisk', 'tabs stay half as long'],
      ]),
      number('budget', 'Visible tabs per window', 'Above this, Ebb shelves the tabs you used least recently, only while you are away. 0 turns it off.', 0, 500),
      checkbox('useShelf', 'Use the Shelf', 'Idle tabs wait in a collapsed “Shelf” group at the end of the tab bar before going to the Library.'),
      checkbox('respectGroups', 'Leave my tab groups alone', 'Tabs in your own groups are only unloaded, never moved.'),
    ),
    h('div', { class: 'group' },
      checkbox('mission', 'Offer to tuck away finished tasks', 'After an order, booking, payment or application confirmation page.'),
      select('laterMode', 'Later lane', 'Where links you open in the background go.', [
        ['guard', 'Open them, but queue extras when one page opens many'],
        ['always', 'Queue every link opened in the background'],
        ['off', 'Always open them as tabs'],
      ]),
      number('laterAllow', 'Background tabs per page', 'How many tabs one page may open within five minutes before extra links go to Later.', 0, 50),
      number('laterExpireDays', 'Later links move to the Library after', 'Days unread. 0 keeps them in Later.', 0, 365),
    ),
    h('div', { class: 'group' },
      checkbox('captureText', 'Keep a short text snippet of tidied pages', 'Makes the Library searchable by what a page said. Stays on this device.'),
      hostList('exemptHosts', 'Never tidy these sites', 'One site per line, like example.com. Its subdomains are included.'),
    ),
    h('div', { class: 'group' },
      h('div', { class: 'tools' },
        fresh.button,
        h('button', { type: 'button', class: 'btn ghost', onClick: exportFile }, 'Export…'),
        h('button', { type: 'button', class: 'btn ghost', onClick: () => importInput.click() }, 'Import…'),
        clear.button,
        importInput,
      ),
      fresh.wrap,
      clear.wrap,
      h('p', { class: 'setting muted small' },
        'Shortcuts: Alt+Shift+K keeps a tab, Alt+Shift+L sends it to Later, Alt+Shift+E opens Ebb. ',
        h('button', { type: 'button', class: 'link', onClick: () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }) }, 'Change shortcuts')),
    ),
    h('p', { class: 'muted small privacy', text: 'Everything Ebb keeps stays on this device. It makes no network requests.' }),
  );
}

function syncSettings() {
  if (!state?.settings) return;
  for (const [key, apply] of controls) {
    const el = document.getElementById(`s-${key}`);
    if (el && document.activeElement === el) continue; // don't fight the user's typing
    apply(state.settings[key]);
  }
}

async function exportFile() {
  try {
    const data = await send({ type: 'panel:export' });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: `ebb-export-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (err) {
    notice(String(err?.message || err));
  }
}

async function importFile(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    await run(send({ type: 'panel:import', data }), (r) => `Imported ${plural(r?.counts?.library || 0, 'Library item')} and ${plural(r?.counts?.later || 0, 'Later link')}.`);
  } catch {
    notice('That file isn’t an Ebb export.');
  }
}

// ---------------------------------------------------------------- navigation & startup

function show(next) {
  view = next;
  try {
    localStorage.setItem('ebb:view', view);
  } catch {
    // Storage unavailable: the panel just opens on Now next time.
  }
  for (const tab of document.querySelectorAll('.tabs [role="tab"]')) {
    const selected = tab.dataset.view === view;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  for (const section of document.querySelectorAll('main > section')) section.hidden = section.dataset.view !== view;
  if (state) render();
  if (view === 'library') loadLibrary();
}

function bind() {
  const tabs = [...document.querySelectorAll('.tabs [role="tab"]')];
  for (const tab of tabs) tab.addEventListener('click', () => show(tab.dataset.view));
  $('.tabs').addEventListener('keydown', (e) => {
    const i = tabs.findIndex((t) => t.dataset.view === view);
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (next == null) return;
    e.preventDefault();
    const tab = tabs[(next + tabs.length) % tabs.length];
    show(tab.dataset.view);
    tab.focus();
  });
  $('#pause').addEventListener('click', () => setSetting({ paused: !state?.settings?.paused }));
  let searchTimer = null;
  $('#library-q').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      library.q = e.target.value;
      library.limit = 60;
      loadLibrary();
    }, 200);
  });
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'ebb:changed') refreshSoon();
  });
  setInterval(() => {
    if (document.visibilityState === 'visible') refresh();
  }, 30000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });
}

async function init() {
  try {
    currentWindowId = (await chrome.windows.getCurrent()).id;
  } catch {
    currentWindowId = null;
  }
  buildSettings();
  bind();
  let saved = 'now';
  try {
    saved = localStorage.getItem('ebb:view') || 'now';
  } catch {
    // Use the default view.
  }
  await refresh();
  show(['now', 'later', 'library', 'ledger', 'settings'].includes(saved) ? saved : 'now');
}

init();
