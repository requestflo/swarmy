import type { DbWritesSince } from '@swarmy/core';

/**
 * "Rows written since" in plain words, pure. The count is Postgres's own
 * (rows inserted, updated or deleted in the app's database), approximate,
 * and starts again when the server restarts, so a reset says that instead.
 */

/** 40 → "~40" · 1234 → "~1.2k" · 12_480 → "~12k" · 3_400_000 → "~3.4M". */
export function approxCount(n: number): string {
  if (n < 1000) return `~${n}`;
  const [v, unit] = n < 999_500 ? [n / 1e3, 'k'] : [n / 1e6, 'M'];
  return `~${v < 10 ? Math.round(v * 10) / 10 : Math.round(v)}${unit}`;
}

/** "~12k rows changed since" · "no rows changed since" · the restart caveat. */
export function writesWords(since: DbWritesSince): string {
  if (since.status === 'reset') return 'Rows changed since this save: unknown. The database restarted after it, so its count started again.';
  if (since.rows === 0) return 'No rows changed since this save.';
  return `${approxCount(since.rows)} ${since.rows === 1 ? 'row' : 'rows'} changed since this save.`;
}
