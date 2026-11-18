# Changelog

## 0.2.0

### New

- **Search the Library from the address bar.** Type `ebb`, a space and a few words to find Later links and Library pages. Enter opens the match in the current tab, a new tab or (with the usual modifier) behind it.
- **A one-time explanation.** The first time Ebb moves tabs to the Shelf on its own, and the first time it closes tabs into the Library, you get a short note when you come back. The Shelf note has a *Show me* button that opens the Shelf.
- **Undo in the panel.** *Close into the Library* and *Send to Later* show a note with Undo.
- **Better at spotting finished tasks.** Ebb now recognizes many more confirmation pages:
  - phrasings like "Your booking in Lisbon is confirmed" and "Your order #1234 has been placed"
  - Amazon-style `/buy/thankyou` addresses
  - event registrations
  - more Czech, German, French and Spanish phrasings

  A receipt now keeps the confirmation page's text, such as the order number.
- Google Scholar searches start tasks like other searches.

### Fixed

- Unsaved typing could stop protecting a tab after the page changed its address in place (`pushState` or `#hash`), so a half-written message could be unloaded. Only a new page now clears it, and pages restored from the back/forward cache report it again.
- Two browser restarts in quick succession lost the tabs that hadn't come back after the first one. They're now saved to the Library.
- A page closed from the Shelf could come back from the Library inside the collapsed Shelf, or in another window. It now opens outside the Shelf, in the window you asked from.
- Closing a Shelf tab by hand, or closing the whole Shelf group, dropped those tabs. They're now kept in the Library ("closed from the Shelf").
- Emptying the Shelf by closing its last tab could leave a stale "Shelf" saved group in Chrome's Tab groups menu, which Chrome syncs when you're signed in. Ebb now removes the group instead.
- The visible-tab budget counted tabs in your own groups, which Ebb never moves, so every other idle tab got shelved. It now counts loose tabs only.
- Tabs Chrome restored without loading were "unloaded" again and counted in the ledger. Tabs another tool asked Chrome to keep loaded (`autoDiscardable: false`) are now left alone.
- Reopening a Library page or Later link that's already open now switches to that tab instead of opening it twice.
- Toast buttons can only act on the task of the page showing them.

### Changed

- Stepping away now means three minutes without input, not one, so reading a page doesn't count as being away.
- Taking a tab off the Shelf folds the rest of the Shelf away again.
- The Library keeps one entry per page; closing the same page again updates it. Imports keep whichever copy is newer.
- Text snippets are stored separately from the tab state. Each save is roughly three times smaller with many tabs open, and saves happen at most once a second. Turning snippets off deletes the ones kept for open tabs.
- Addresses that differ only by an app route (`#/inbox`) are no longer treated as the same page; `si` share parameters are ignored like other tracking parameters.

## 0.1.0

First version: tabs ebb from resting to the Shelf to the Library on an active-time clock; tasks (hunts), mission accomplished, the Later lane, resume after restart, and the regret ledger; side panel and welcome page.
