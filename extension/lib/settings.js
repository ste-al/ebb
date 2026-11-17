// User settings with safe defaults. Everything is optional; Ebb works with zero setup.

import { PACE } from './lifetimes.js';
import { LATER_MODES } from './later.js';

export const DEFAULT_SETTINGS = Object.freeze({
  paused: false,
  pace: 'balanced', // gentle | balanced | brisk
  budget: 15, // soft cap on visible tabs per window; 0 turns it off
  useShelf: true, // collapsed "Shelf" tab group before the Library
  laterMode: 'guard', // off | guard | always
  laterAllow: 4, // guard: background tabs allowed per page within laterWindowMin
  laterWindowMin: 5,
  laterExpireDays: 14,
  mission: true, // offer to tuck away a hunt after a confirmation page
  respectGroups: true, // tabs in your own tab groups only rest, never move
  captureText: true, // keep a short text excerpt of tidied pages for search (stays on this device)
  exemptHosts: [],
});

/** Merge stored settings with defaults and drop anything unknown or invalid. */
export function withDefaults(stored = {}) {
  const s = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (stored && typeof stored === 'object' && key in stored) s[key] = stored[key];
  }
  if (!(s.pace in PACE)) s.pace = DEFAULT_SETTINGS.pace;
  if (!LATER_MODES.includes(s.laterMode)) s.laterMode = DEFAULT_SETTINGS.laterMode;
  s.budget = clampInt(s.budget, 0, 500, DEFAULT_SETTINGS.budget);
  s.laterAllow = clampInt(s.laterAllow, 0, 50, DEFAULT_SETTINGS.laterAllow);
  s.laterWindowMin = clampInt(s.laterWindowMin, 1, 120, DEFAULT_SETTINGS.laterWindowMin);
  s.laterExpireDays = clampInt(s.laterExpireDays, 0, 365, DEFAULT_SETTINGS.laterExpireDays);
  s.exemptHosts = Array.isArray(s.exemptHosts)
    ? [...new Set(s.exemptHosts.map((h) => String(h).trim().toLowerCase()).filter(Boolean))]
    : [];
  for (const key of ['paused', 'useShelf', 'mission', 'respectGroups', 'captureText']) s[key] = Boolean(s[key]);
  return s;
}

function clampInt(v, lo, hi, fallback) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}
