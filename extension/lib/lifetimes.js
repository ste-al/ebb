// How long a tab stays in each stage, measured in ACTIVE browsing time
// (the clock only runs while Chrome is focused and you are at the keyboard).
//
// Stages: live -> resting (unloaded in place) -> shelved (collapsed "Shelf" group) -> archived (closed, in the Library).
// Generations: tabs you never come back to get short lives; tabs you keep revisiting get long ones.

import { MIN, isWebUrl } from './util.js';
import { isExempt } from './classify.js';

export const STAGES = ['live', 'resting', 'shelved', 'archived'];
export const STAGE_RANK = { live: 0, resting: 1, shelved: 2, archived: 3 };

/** Base thresholds in active minutes, per generation. */
export const BASE_MINUTES = [
  { rest: 30, shelf: 180, archive: 1440 }, // gen 0: opened once (or never looked at)
  { rest: 120, shelf: 720, archive: 4320 }, // gen 1: came back once
  { rest: 360, shelf: 2880, archive: 20160 }, // gen 2: came back two or more times
];

export const PACE = { gentle: 2, balanced: 1, brisk: 0.5 };

export const KIND_MULTIPLIER = {
  search: 0.5,
  news: 0.5,
  social: 0.5,
  video: 1,
  shopping: 1,
  other: 1,
  doc: 2,
  reference: 2,
};

/** visits counts activations: 0 = opened in background and never looked at. */
export function generation(visits) {
  if (visits >= 3) return 2;
  if (visits === 2) return 1;
  return 0;
}

/**
 * Thresholds in milliseconds of active time.
 * @param {{visits:number, kind:string, pace?:string, hostMultiplier?:number}} p
 */
export function thresholds({ visits = 0, kind = 'other', pace = 'balanced', hostMultiplier = 1 }) {
  const base = BASE_MINUTES[generation(visits)];
  const m = (PACE[pace] ?? 1) * (KIND_MULTIPLIER[kind] ?? 1) * (hostMultiplier || 1);
  return {
    rest: base.rest * m * MIN,
    shelf: base.shelf * m * MIN,
    archive: base.archive * m * MIN,
  };
}

/** The stage a tab of this idle age should be in. */
export function targetStage(ageMs, th) {
  if (ageMs >= th.archive) return 'archived';
  if (ageMs >= th.shelf) return 'shelved';
  if (ageMs >= th.rest) return 'resting';
  return 'live';
}

/** Next transition for UI copy: { stage, inMs } or null when nothing is coming. */
export function nextTransition(stage, ageMs, th) {
  const order = [
    ['resting', th.rest],
    ['shelved', th.shelf],
    ['archived', th.archive],
  ];
  for (const [next, at] of order) {
    if (STAGE_RANK[next] > STAGE_RANK[stage]) return { stage: next, inMs: Math.max(0, at - ageMs) };
  }
  return null;
}

/**
 * Why a tab must not be touched right now, or null when Ebb may act on it.
 * @param {chrome.tabs.Tab} tab
 * @param {object} record Ebb's record for the tab
 * @param {{now:number, paused:boolean, exemptHosts:string[]}} ctx
 */
export function protection(tab, record, ctx) {
  if (ctx.paused) return 'paused';
  if (!tab) return 'gone';
  if (tab.active) return 'in view';
  if (tab.pinned) return 'pinned';
  if (tab.audible) return 'playing';
  const url = tab.url || tab.pendingUrl || record?.url || '';
  if (!isWebUrl(url)) return 'not a web page';
  if (record?.keep === 'always') return 'kept';
  if (record?.keepUntil && record.keepUntil > ctx.now) return 'kept for now';
  if (record?.dirty) return 'unsaved input';
  if (record?.kind === 'app') return 'app';
  if (isExempt(url, ctx.exemptHosts)) return 'exempt site';
  return null;
}
