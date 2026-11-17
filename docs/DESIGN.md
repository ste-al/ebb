# How Ebb works

Notes for anyone changing Ebb: the principles behind it, how the code is organized, and the rules it follows, with the reasons for them.

## Principles

1. **Zero setup.** Everything works on day one with defaults. No grouping, tagging or saving is ever required.
2. **Nothing is lost.** Every automatic action can be undone, and closed tabs keep their place on the page and a text snippet, so they are findable later.
3. **Don't move things under the user's cursor.** Unloading a tab changes nothing visible, so it can happen any time. Anything that moves or closes tabs waits for a natural boundary: the user is idle or has switched to another app.
4. **Measure attention, not wall time.** Lifetimes count active browsing time, and stretch for tabs the user keeps coming back to.
5. **Offer at task boundaries, never act on guesses.** Heuristics like "this order is done" only produce an offer with one click to accept and one to undo.
6. **Show the receipts.** The ledger counts every action and every regret, and its numbers tune lifetimes.
7. **Local only.** No network requests, no accounts, no analytics.

## Architecture

```
chrome.* events ──► lib/wiring.js ──► Engine.dispatch(handler) ──► lib/engine.js
                                                                     │
                                ports (lib/chrome-ports.js) ◄────────┘
                                tabs, groups, windows, sessions, storage,
                                IndexedDB repo (lib/idb.js), badge, messaging
```

- **`lib/engine.js`** holds all behavior. It never touches `chrome.*` directly; it calls *ports*. `lib/chrome-ports.js` implements them on Chrome, and `test/fakes/fake-browser.js` implements them in memory for tests.
- **Serialized handlers.** The MV3 service worker can be stopped at any moment, so each handler runs through `dispatch()`, a promise queue that loads state on demand, runs one handler at a time and saves afterwards (debounced by 400 ms).
- **Page round trips run outside the queue.** Asking a page for its scroll position or reading a confirmation page can be slow, so that work is `spawn()`ed outside the queue and its results are applied back through `dispatch()`. The queue stays responsive to tab events.
- **The pure rules** live in small modules with no browser access: `lifetimes.js`, `hunts.js`, `search.js`, `classify.js`, `mission.js`, `later.js`, `ledger.js`, `settings.js`.
- **Storage.** Live state (tab records, hunts, the clock) is one object in `chrome.storage.local`. The Library, Later items and ledger events live in IndexedDB (`library`, `later`, `ledger` stores), which is better suited to growing collections.
- **The content script** is deliberately small and passive. It answers questions (`ebb:capture`, `ebb:signals`, `ebb:link-info`), applies a scroll/media restore, reports unsaved typing, and shows toasts in a closed shadow root. All decisions are made in the service worker.
- **The side panel** renders a view model from `Engine.viewModel()` and sends every action back as a message. It sets page titles and URLs as text only, and only accepts imported URLs that are `http(s)`.

## The lifecycle

Each tab has a record with its URL, task (hunt), visits, stage, last-active time on the active clock, and a "freeze" (scroll position, scroll ratio, media time, and once per URL a text snippet).

| Stage | What it means | When |
| --- | --- | --- |
| live | loaded | |
| resting | unloaded in place with `tabs.discard` | any time |
| shelved | in the window's collapsed **Shelf · N** group at the end of the tab bar | at a boundary |
| archived | closed into the Library | at a boundary, after at least an active hour on the Shelf |

**Thresholds** in active minutes for pace *balanced* and an ordinary page:

| Visits | Rest | Shelf | Library |
| --- | --- | --- | --- |
| 0–1 (opened once, or never looked at) | 30 | 180 | 1,440 |
| 2 | 120 | 720 | 4,320 |
| 3 or more | 360 | 2,880 | 20,160 |

These are multiplied by the pace (gentle ×2, brisk ×0.5), the page kind (search, news and social ×0.5; documents and references ×2), and a per-site factor from the ledger (×2 or ×3). A visit counts when the user returns after at least two active minutes away, so flicking between tabs doesn't inflate it.

**The active clock** advances on each one-minute alarm, but only while a Chrome window has focus and `chrome.idle` reports *active*. Each step is capped at two minutes, so a laptop waking from sleep doesn't jump the clock. A tab's idle time starts when the user *leaves* it, and the tab in view in each window keeps resetting its own.

**Boundaries.** Going idle or locked triggers a pass right away. Losing focus is noted and acted on by the next tick, because focus briefly drops to "no window" while switching between Chrome windows.

**Limits per pass.** At most 40 unloads and 25 moves, so a large backlog is tidied gradually. A tab that refuses to unload isn't retried for 30 active minutes.

**Protection.** A tab is skipped if it is in view, pinned, audible, not an `http(s)` page, kept, has unsaved typing, is a known web app (mail, calendar, chat and so on), is on an exempt site, or Ebb is paused. Tabs in the user's own groups only ever rest. The content script reports unsaved typing when a text field the user typed in is non-empty (never reading its contents), and for 30 minutes after typing in a rich editor. It reports as the user types and again when they leave the tab, and any capture taken just before unloading carries its latest answer.

**The soft budget.** When a window shows more visible tabs than the budget (15), the least recently used unprotected tabs are shelved at a boundary. Two guards keep this from feeling like a purge: it never runs in the first active hour after install, and never touches tabs used in the last 20 active minutes.

## Hunts

A committed main-frame navigation updates the tab's hunt (`hunts.js`):

- A search results page (Google, Bing, DuckDuckGo, Seznam, YouTube, Amazon and others, in `search.js`) continues the current search hunt if the query is similar: Jaccard similarity of the query words, accents folded and stopwords removed, ≥ 0.5, or ≥ 0.25 when refining within ten minutes. Otherwise it starts a new hunt named by the query.
- A navigation the user started (typed, bookmark, keyword…) starts a new site hunt unless it stays on the same site.
- Links keep the current hunt. Tabs opened from a tab inherit its hunt.
- A tab Ebb reopens keeps its hunt on its first load, whatever transition type Chrome reports for that load.

## Mission accomplished

When a page in a hunt with at least three tabs finishes loading, Ebb waits briefly for late rendering, then asks the page for its title, top headings and whether it shows a reference number. `detectMission()` scores the evidence: a confirmation-like URL scores 2 (a weak "thank you" URL scores 1), a confirmation heading scores 2, and a reference number scores 1. It needs a score of 2 with a known kind, or 3 without. An offer is shown only if at least two *other* tabs in the hunt could be tucked away, and at most once per hunt every six hours. Accepting archives those tabs as one batch, saves a receipt of the confirmation page, and offers Undo.

## The Later lane

`webNavigation.onCreatedNavigationTarget` reports tabs a page opens. In *guard* mode, background tabs beyond the fourth from the same page within five minutes are closed right away and saved as Later items, named after the clicked link's text. *Always* queues every background tab, *off* never does. Unread items move to the Library after 14 days.

## Restarts, reloads and closed windows

Tab ids change when the browser restarts. They don't when Ebb itself is reloaded, but both empty `chrome.storage.session`. So when the engine loads with an empty session marker, it checks whether most of the tabs it knew still exist with the same addresses:

- **Yes:** the extension was reloaded. Ebb reconciles its records with the open tabs.
- **No:** the browser restarted. All old records are set aside, keyed by normalized address, and for two minutes restored tabs are *adopted* by address, keeping their hunt and history. Tabs that were resting or shelved are unloaded again rather than left loading. Records nobody adopted go to the Library as *didn't come back after a restart*. A resume card lists the hunts.

This doesn't depend on `runtime.onStartup` arriving before the first tab events; a late `onStartup` is ignored. When a window closes, its tabs' records wait five minutes in *limbo* in case the window is reopened. After that, the ones Ebb had tidied (resting or shelved) go to the Library.

## Coming back

- **Off the Shelf:** selecting a shelved tab ungroups it and moves it next to the other tabs of its hunt, or just before the Shelf.
- **From the Library:** a tab closed in the last six hours that is still in Chrome's *Recently closed* list is restored with `sessions.restore`, so it comes back with its back/forward history. Otherwise a new tab opens just before the Shelf.
- **Scroll position:** a pending restore is tied to the page's address and applied when that page finishes loading, and only if the page didn't restore its own position. Chrome starts reloading an unloaded tab the moment it is selected, so Ebb decides this from its own record rather than from `tab.discarded`.
- **Undo of a batch:** the tabs reopen in the background and are unloaded as soon as each one has its address, so dozens of tabs never load at once.

## The ledger

Every action is an event: `rest`, `shelve`, `archive`, `tuck`, `later`, `restore`, `open-later`. *Tidied* counts tabs that left view once: shelved, queued, tucked or archived, but not archived from the Shelf, which was already counted. The regret rate is restores ÷ tidied. A site with at least three restores in 90 days gets ×2 lifetimes at a 20% restore rate and ×3 at 40%. Events are kept for 180 days.

## Testing

- `test/unit`: the pure rules, plus the IndexedDB repo on `fake-indexeddb`.
- `test/engine`: scenarios that run the real engine and the real event wiring against `FakeBrowser`. The fake mimics the Chrome behavior Ebb relies on: event order and snapshots, tab strip order, group contiguity, a click reloading an unloaded tab, recently closed sessions, and content-script replies.
- `test/e2e`: loads the unpacked extension into Chrome for Testing and drives it against a local site. Hostnames like `shop.test` are mapped to the local server, so separate sites form separate hunts. It covers install, capture and unloading, the Shelf, Library restore with history, the Later lane (clicking the real toast button), mission accomplished with Undo, and the side panel.

## Ideas for later

- A Firefox version (sidebar instead of side panel, and a different Shelf)
- Search the Library from the address bar (an omnibox keyword)
- Optional sync of the Library between devices, end-to-end encrypted
- Per-hunt notes, and naming or merging hunts by hand for those who want to
- Smarter page kinds learned from how the user treats each site
