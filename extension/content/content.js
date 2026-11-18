// Ebb's content script. Small and passive: it answers questions from Ebb's service worker
// (scroll position, a short text excerpt, confirmation-page signals), remembers the link you
// last clicked, notices unsaved input (checking only whether fields are empty, never what you
// typed) and shows Ebb's toasts. Nothing here leaves your device.

(() => {
  const KEY = '__ebbContent';
  const previous = globalThis[KEY];
  if (previous?.alive()) return;
  previous?.retire(); // a copy left behind by an older version of Ebb

  let retired = false;
  const cleanups = [];
  const alive = () => !retired && Boolean(globalThis.chrome?.runtime?.id);
  const on = (target, type, fn, options) => {
    target.addEventListener(type, fn, options);
    cleanups.push(() => target.removeEventListener(type, fn, options));
  };
  const send = (msg) => {
    if (!alive()) return Promise.resolve(null);
    try {
      return chrome.runtime.sendMessage(msg).catch(() => null);
    } catch {
      return Promise.resolve(null); // Ebb was reloaded; this copy is about to retire
    }
  };
  const clean = (s, max = 300) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

  // ---------------------------------------------------------------- unsaved input

  const NOT_TEXT = new Set(['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image', 'hidden', 'search', 'password']);
  const EDITABLE_FOR = 30 * 60 * 1000; // rich editors usually autosave; protect them for a while after typing
  const touched = new Set();
  let editedAt = 0;
  let dirty = false;
  let recomputeTimer = null;
  let expiryTimer = null;

  const isTextField = (el) => {
    if (!(el instanceof Element)) return false;
    if (el.tagName === 'TEXTAREA') return true;
    return el.tagName === 'INPUT' && !NOT_TEXT.has((el.type || 'text').toLowerCase());
  };

  function recompute() {
    clearTimeout(recomputeTimer);
    for (const el of touched) if (!el.isConnected) touched.delete(el);
    const now = Date.now();
    const editing = editedAt > 0 && now - editedAt < EDITABLE_FOR;
    const next = editing || [...touched].some((el) => typeof el.value === 'string' && el.value.length > 0);
    clearTimeout(expiryTimer);
    if (editing) expiryTimer = setTimeout(recompute, EDITABLE_FOR - (now - editedAt) + 1000);
    if (next !== dirty) {
      dirty = next;
      send({ type: 'ebb:dirty', dirty });
    }
  }
  const soon = () => {
    clearTimeout(recomputeTimer);
    recomputeTimer = setTimeout(recompute, 400);
  };

  on(document, 'input', (e) => {
    if (!e.isTrusted) return;
    const el = e.composedPath?.()[0] || e.target;
    if (isTextField(el)) touched.add(el);
    else if (el instanceof Element && el.isContentEditable) editedAt = Date.now();
    else return;
    soon();
  }, true);
  on(document, 'submit', (e) => {
    for (const el of touched) if (e.target?.contains?.(el)) touched.delete(el);
    editedAt = 0;
    soon();
  }, true);
  on(document, 'keyup', (e) => {
    if (e.key === 'Enter' && (touched.size || editedAt)) soon();
  }, true);
  on(document, 'click', () => {
    if (touched.size || editedAt) soon();
  }, true);
  on(document, 'visibilitychange', () => {
    if (document.visibilityState === 'hidden') recompute();
  });
  // Back/forward cache: the page comes back as it was, typing included, but Ebb's record of it
  // was reset by the navigation. Report the current state again.
  on(window, 'pageshow', (e) => {
    if (e.persisted && dirty) send({ type: 'ebb:dirty', dirty });
  });

  // ---------------------------------------------------------------- the link you last clicked

  let lastLink = null;
  const rememberLink = (e) => {
    if (!e.isTrusted || !(e.target instanceof Element)) return;
    const a = e.target.closest('a[href]');
    if (!a) return;
    const href = typeof a.href === 'string' ? a.href : a.href?.baseVal;
    if (!href) return;
    lastLink = { url: href, text: clean(a.innerText || a.textContent || a.title || a.getAttribute('aria-label'), 200), at: Date.now() };
  };
  on(document, 'mousedown', rememberLink, true);
  on(document, 'auxclick', rememberLink, true);
  on(document, 'contextmenu', rememberLink, true);
  on(document, 'keydown', (e) => {
    if (e.key === 'Enter') rememberLink(e);
  }, true);

  const withoutHash = (url) => {
    try {
      const u = new URL(url, location.href);
      u.hash = '';
      return u.href;
    } catch {
      return String(url);
    }
  };
  function linkInfo(url) {
    if (!lastLink) return null;
    const age = Date.now() - lastLink.at;
    if (age > 15000) return null;
    if (withoutHash(lastLink.url) === withoutHash(url) || age < 1500) return { text: lastLink.text };
    return null;
  }

  // ---------------------------------------------------------------- reading the page

  const SKIP_FOR_EXCERPT = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'FORM', 'BUTTON', 'SELECT', 'OPTION', 'TEXTAREA', 'INPUT']);
  const SKIP_FOR_SIGNALS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME']);

  /** Visible-ish text under root, up to about max characters. Cheap: stops early. */
  function collectText(root, max, skip) {
    if (!root) return '';
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (skip.has(node.tagName.toUpperCase()) || node.hidden || node.getAttribute('aria-hidden') === 'true') {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let text = '';
    while (text.length < max && walker.nextNode()) {
      const value = walker.currentNode.nodeValue.replace(/\s+/g, ' ').trim();
      if (value) text += (text ? ' ' : '') + value;
    }
    return text;
  }

  function truncate(text, max) {
    if (text.length <= max) return text;
    const cut = text.slice(0, max);
    const space = cut.lastIndexOf(' ');
    return (space > max * 0.6 ? cut.slice(0, space) : cut) + '…';
  }

  function meta(name) {
    const el = document.querySelector(`meta[name="${name}" i], meta[property="${name}" i]`);
    return el?.getAttribute('content') || '';
  }

  function mediaState() {
    return [...document.querySelectorAll('video, audio')]
      .filter((m) => m.currentTime > 0)
      .slice(0, 3)
      .map((m) => ({ currentTime: m.currentTime, duration: Number.isFinite(m.duration) ? m.duration : 0, paused: m.paused }));
  }

  function capture(withText) {
    const doc = document.scrollingElement || document.documentElement;
    const range = Math.max(1, (doc?.scrollHeight || 0) - window.innerHeight);
    recompute();
    const out = {
      scrollY: Math.round(window.scrollY),
      scrollRatio: Math.min(1, window.scrollY / range),
      title: document.title,
      media: mediaState(),
      dirty,
    };
    if (withText) {
      const root = document.querySelector('article') || document.querySelector('main, [role="main"]') || document.body;
      out.excerpt = truncate(collectText(root, 900, SKIP_FOR_EXCERPT), 600);
      out.description = clean(meta('description') || meta('og:description'), 300);
    }
    return out;
  }

  function signals(source, flags) {
    const headings = [...document.querySelectorAll('h1, h2, [role="heading"], [role="alert"], [role="status"]')]
      .slice(0, 12)
      .map((h) => clean(h.innerText || h.textContent, 200))
      .filter(Boolean);
    let hasReference = false;
    try {
      const re = new RegExp(String(source), String(flags || '').replace(/[^imsu]/g, ''));
      hasReference = re.test(collectText(document.body, 20000, SKIP_FOR_SIGNALS));
    } catch {
      // A pattern this browser can't compile: treat as no reference number.
    }
    return { title: document.title, headings, hasReference };
  }

  // ---------------------------------------------------------------- putting you back where you were

  let userScrolled = false;
  const scrolledByUser = () => {
    userScrolled = true;
  };
  on(window, 'wheel', scrolledByUser, { passive: true, capture: true });
  on(window, 'touchmove', scrolledByUser, { passive: true, capture: true });
  on(window, 'keydown', (e) => {
    if (['PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', 'Home', 'End', ' '].includes(e.key)) userScrolled = true;
  }, true);

  function restore(freeze) {
    if (!freeze || typeof freeze !== 'object') return;
    const wanted = Math.max(0, Number(freeze.scrollY) || 0);
    const ratio = Math.min(1, Math.max(0, Number(freeze.scrollRatio) || 0));
    // Only if the page did not restore its own position (and you haven't scrolled).
    if (wanted >= 100 && window.scrollY < 50) {
      userScrolled = false;
      let tries = 0;
      const step = () => {
        if (userScrolled) return;
        const doc = document.scrollingElement || document.documentElement;
        const range = Math.max(0, doc.scrollHeight - window.innerHeight);
        window.scrollTo({ top: range >= wanted ? wanted : Math.round(ratio * range), behavior: 'instant' });
        if (range < wanted && ++tries < 4) setTimeout(step, 700); // content may still be loading
      };
      step();
    }
    restoreMedia(freeze.media);
  }

  function restoreMedia(media) {
    const seconds = Number(Array.isArray(media) ? media[0]?.currentTime : 0) || 0;
    if (seconds < 5) return;
    const apply = (el) => {
      if (el.currentTime >= 1) return; // the site already resumed it
      try {
        el.currentTime = seconds;
      } catch {
        // Not seekable.
      }
    };
    const whenReady = (el) => (el.readyState >= 1 ? apply(el) : el.addEventListener('loadedmetadata', () => apply(el), { once: true }));
    const found = document.querySelector('video, audio');
    if (found) {
      whenReady(found);
      return;
    }
    const observer = new MutationObserver(() => {
      const el = document.querySelector('video, audio');
      if (!el) return;
      observer.disconnect();
      whenReady(el);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 10000);
  }

  // ---------------------------------------------------------------- toasts

  const STYLE = `
    :host { all: initial; }
    .box { box-sizing: border-box; display: flex; align-items: center; gap: 10px;
      max-width: min(460px, calc(100vw - 32px)); padding: 10px 8px 10px 12px; border-radius: 12px;
      background: #ffffff; color: #0f172a;
      box-shadow: 0 10px 30px rgba(15, 23, 42, .18), 0 0 0 1px rgba(15, 23, 42, .08);
      font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; animation: rise .18s ease-out; }
    .mark { flex: none; width: 20px; height: 20px; border-radius: 6px; background: #0f766e; display: grid; place-items: center; }
    .text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    button { font: inherit; font-weight: 600; border: 0; border-radius: 8px; padding: 6px 10px; cursor: pointer; white-space: nowrap; }
    .primary { background: #0f766e; color: #ffffff; }
    .primary:hover { background: #115e59; }
    .ghost { background: transparent; color: #475569; }
    .ghost:hover { background: rgba(15, 23, 42, .06); }
    .close { background: transparent; color: #64748b; padding: 4px 7px; font-size: 16px; line-height: 1; font-weight: 400; }
    .close:hover { background: rgba(15, 23, 42, .06); }
    button:focus-visible { outline: 2px solid #0f766e; outline-offset: 2px; }
    @media (prefers-color-scheme: dark) {
      .box { background: #1e293b; color: #e2e8f0; box-shadow: 0 10px 30px rgba(0, 0, 0, .45), 0 0 0 1px rgba(255, 255, 255, .08); }
      .primary { background: #2dd4bf; color: #042f2e; }
      .primary:hover { background: #5eead4; }
      .ghost, .close { color: #cbd5e1; }
      .ghost:hover, .close:hover { background: rgba(255, 255, 255, .08); }
    }
    @keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    @media (prefers-reduced-motion: reduce) { .box { animation: none; } }
  `;

  let sheet = null;
  function styleInto(root) {
    try {
      if (!sheet) {
        sheet = new CSSStyleSheet();
        sheet.replaceSync(STYLE);
      }
      root.adoptedStyleSheets = [sheet];
    } catch {
      const style = document.createElement('style');
      style.textContent = STYLE;
      root.append(style);
    }
  }

  function waveMark() {
    const NS = 'http://www.w3.org/2000/svg';
    const span = document.createElement('span');
    span.className = 'mark';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M3 14c2.5 0 2.5-3 5-3s2.5 3 5 3 2.5-3 5-3 2.5 3 3 3');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', '#ffffff');
    path.setAttribute('stroke-width', '2.4');
    path.setAttribute('stroke-linecap', 'round');
    svg.append(path);
    span.append(svg);
    return span;
  }

  let current = null;
  function hideToast() {
    if (!current) return;
    clearTimeout(current.timer);
    current.host.remove();
    current = null;
  }

  function showToast(toast) {
    if (!toast || typeof toast.text !== 'string') return;
    hideToast();
    const host = document.createElement('ebb-toast');
    const position = { position: 'fixed', right: '16px', bottom: '16px', 'z-index': '2147483647', display: 'block', margin: '0', padding: '0', border: '0', background: 'none' };
    for (const [prop, value] of Object.entries(position)) host.style.setProperty(prop, value, 'important');
    const root = host.attachShadow({ mode: 'closed' });
    styleInto(root);

    const box = document.createElement('div');
    box.className = 'box';
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = toast.text;
    box.append(waveMark(), text);

    for (const action of (Array.isArray(toast.actions) ? toast.actions : []).slice(0, 3)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = action.id === 'dismiss' ? 'ghost' : 'primary';
      button.textContent = String(action.label || 'OK');
      button.addEventListener('click', (e) => {
        if (e.isTrusted) act(action);
      });
      box.append(button);
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'close';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    close.addEventListener('click', (e) => {
      if (e.isTrusted) hideToast();
    });
    box.append(close);
    root.append(box);
    (document.body || document.documentElement).append(host);

    const ms = Math.min(Math.max(Number(toast.timeoutMs) || 6000, 2000), 30000);
    const entry = { host, timer: setTimeout(hideToast, ms) };
    current = entry;
    box.addEventListener('mouseenter', () => clearTimeout(entry.timer));
    box.addEventListener('mouseleave', () => {
      clearTimeout(entry.timer);
      if (current === entry) entry.timer = setTimeout(hideToast, 2500);
    });
  }

  async function act(action) {
    hideToast();
    if (action.id === 'dismiss') return;
    const res = await send({ type: 'ebb:toast-action', action: String(action.id), data: action.data || {} });
    if (res?.toast) showToast(res.toast);
  }

  // ---------------------------------------------------------------- messages from Ebb

  const onMessage = (msg, _sender, sendResponse) => {
    if (!alive() || !msg || typeof msg.type !== 'string') return false;
    switch (msg.type) {
      case 'ebb:ping':
        sendResponse({ ok: true });
        break;
      case 'ebb:capture':
        sendResponse(capture(Boolean(msg.text)));
        break;
      case 'ebb:signals':
        sendResponse(signals(msg.reference, msg.flags));
        break;
      case 'ebb:restore':
        restore(msg.freeze);
        sendResponse({ ok: true });
        break;
      case 'ebb:link-info':
        sendResponse(linkInfo(msg.url));
        break;
      case 'ebb:toast':
        showToast(msg.toast);
        sendResponse({ ok: true });
        break;
      default:
        return false;
    }
    return false;
  };
  chrome.runtime.onMessage.addListener(onMessage);
  cleanups.push(() => chrome.runtime.onMessage.removeListener(onMessage));

  globalThis[KEY] = {
    alive,
    retire() {
      retired = true;
      for (const fn of cleanups.splice(0)) {
        try {
          fn();
        } catch {
          // The old extension context is gone; nothing to remove.
        }
      }
      clearTimeout(recomputeTimer);
      clearTimeout(expiryTimer);
      hideToast();
    },
  };
})();
