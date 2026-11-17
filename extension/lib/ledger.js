// The regret ledger: every automatic action and every "bring it back" is logged,
// so Ebb can show how rarely tidied tabs are needed and lengthen lifetimes for
// sites you often bring back.
//
// Event types
//   rest       tab unloaded in place (memory only, still visible)
//   shelve     tab moved to the Shelf
//   archive    tab closed into the Library   (from: live | resting | shelved | later)
//   tuck       tab archived because its task was done (mission accomplished)
//   later      background link queued instead of opened
//   restore    a tidied tab was brought back  (from: shelf | library | undo)
//   open-later a Later item was opened (intended use, not a regret)

import { DAY } from './util.js';

/**
 * Weekly (or any window) summary.
 * "tidied" counts tabs that left view once: shelving, queueing, tucking, and archiving
 * of tabs that were not already on the Shelf or in Later.
 */
export function summarize(events, { since = 0 } = {}) {
  const s = { rested: 0, shelved: 0, archived: 0, tucked: 0, queued: 0, restored: 0, openedLater: 0, tidied: 0, rate: 0 };
  for (const e of events) {
    if (e.at < since) continue;
    switch (e.type) {
      case 'rest': s.rested += 1; break;
      case 'shelve': s.shelved += 1; s.tidied += 1; break;
      case 'archive':
        s.archived += 1;
        if (e.from !== 'shelved' && e.from !== 'later') s.tidied += 1;
        break;
      case 'tuck':
        s.tucked += 1;
        if (e.from !== 'shelved') s.tidied += 1;
        break;
      case 'later': s.queued += 1; s.tidied += 1; break;
      case 'restore': s.restored += 1; break;
      case 'open-later': s.openedLater += 1; break;
      default: break;
    }
  }
  s.rate = s.tidied ? s.restored / s.tidied : 0;
  return s;
}

/**
 * Sites you bring back often get longer lifetimes.
 * @returns {Record<string, number>} host -> multiplier (only hosts above 1)
 */
export function hostMultipliers(events, { since = 0, minRestores = 3 } = {}) {
  const tidied = new Map();
  const restored = new Map();
  for (const e of events) {
    if (e.at < since || !e.host) continue;
    if (e.type === 'shelve' || e.type === 'later' || ((e.type === 'archive' || e.type === 'tuck') && e.from !== 'shelved')) {
      tidied.set(e.host, (tidied.get(e.host) || 0) + 1);
    } else if (e.type === 'restore') {
      restored.set(e.host, (restored.get(e.host) || 0) + 1);
    }
  }
  const out = {};
  for (const [host, r] of restored) {
    const t = Math.max(tidied.get(host) || 0, r);
    if (r < minRestores) continue;
    const rate = r / t;
    if (rate >= 0.4) out[host] = 3;
    else if (rate >= 0.2) out[host] = 2;
  }
  return out;
}

/** Plain-language line for the panel. */
export function ledgerSentence(s) {
  if (!s.tidied) return 'Nothing tidied yet. Ebb only acts on tabs you leave alone.';
  const pct = Math.round(s.rate * 1000) / 10;
  return `Ebb tidied ${s.tidied} tab${s.tidied === 1 ? '' : 's'} and you brought back ${s.restored} (${pct}%). Nothing was deleted.`;
}

export const LEDGER_RETENTION_MS = 180 * DAY;
