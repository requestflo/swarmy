import { dataHistorySlots, dataHistoryStepSeconds } from '@swarmy/core';
import { diskGridFrom } from './alerts-disk-history';

/**
 * The fixed grid every managed data history read returns (the
 * `nodes.statsHistory` shape): `slots` display slots of `step` seconds,
 * ending with the slot that holds now. The SQL groups rows by
 * `epoch seconds ÷ step`; `slotGrid` places those groups. Pure.
 */

export interface HistoryWindow {
  /** Display slot, seconds. */
  step: number;
  slots: number;
  /** First slot's start (ms). */
  from: number;
}

export function historyWindow(hours: number, now: number): HistoryWindow {
  const step = dataHistoryStepSeconds(hours);
  const slots = dataHistorySlots(hours);
  return { step, slots, from: diskGridFrom(now, step, slots) };
}

/** A SQL number (number, bigint or null) → a finite number or null. */
export function sqlNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export type SlotRow<K extends string> = { slot: number | bigint } & { [P in K]?: unknown };

/**
 * Slot rows → one series per field, on the window's grid. A row outside the
 * window is dropped; an empty slot stays null.
 */
export function slotGrid<K extends string>(
  rows: ReadonlyArray<SlotRow<K>>,
  keys: readonly K[],
  w: HistoryWindow,
): Record<K, Array<number | null>> {
  const first = Math.floor(w.from / 1000 / w.step);
  const out = {} as Record<K, Array<number | null>>;
  for (const k of keys) out[k] = new Array<number | null>(w.slots).fill(null);
  for (const r of rows) {
    const i = Number(r.slot) - first;
    if (!Number.isInteger(i) || i < 0 || i >= w.slots) continue;
    for (const k of keys) out[k][i] = sqlNum(r[k]);
  }
  return out;
}
