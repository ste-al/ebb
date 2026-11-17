// The Later lane: links opened in the background become queue items instead of tabs.
//
// Modes
//   off     never queue
//   guard   let the first few background tabs from one page open, queue the rest
//           ("rabbit-hole guard": a page spawning many tabs in minutes)
//   always  every link opened in the background goes to Later

import { MIN } from './util.js';

export const LATER_MODES = ['off', 'guard', 'always'];

/**
 * Decide whether a background-opened link should be queued.
 * @param {{mode:string, allow:number, windowMin:number, now:number, history:number[]}} p
 *   history: timestamps of earlier background spawns from the same source page
 * @returns {{queue:boolean, history:number[]}} updated history to store for the source
 */
export function decideLater({ mode, allow = 4, windowMin = 5, now, history = [] }) {
  const recent = history.filter((t) => now - t < windowMin * MIN);
  recent.push(now);
  if (mode === 'always') return { queue: true, history: recent };
  if (mode === 'guard') return { queue: recent.length > allow, history: recent };
  return { queue: false, history: recent };
}

/** Later items unread for this long move to the Library. */
export function isExpired(item, now, expireDays) {
  if (!expireDays || item.openedAt) return false;
  return now - item.savedAt > expireDays * 24 * 60 * MIN;
}
