import type { AppRestoreLeftOutWhy, AppRestorePart, AppRestorePlan, AppRestoreRefusal } from '@swarmy/core';
import { clockLabel, momentLabel } from './time-travel-model';

/**
 * The whole-app restore in plain words, pure: where each part lands and how
 * far apart they are ("Files from 14:00, the database from 14:02."), which
 * parts can't go back that far, and what is left alone.
 */

const sameDay = (a: number, b: number): boolean => new Date(a).toDateString() === new Date(b).toDateString();

/** "14:00" on the head's day, "Tue 22 · 14:00" on another. */
export function whenLabel(t: number, head: number): string {
  return sameDay(t, head) ? clockLabel(t) : momentLabel(t);
}

/** "40 s" · "2 min" · "1 h 5 min" · "2 d 3 h". */
export function spanWords(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  const mins = Math.round(ms / 60_000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  if (d) return h ? `${d} d ${h} h` : `${d} d`;
  return h ? (mins % 60 ? `${h} h ${mins % 60} min` : `${h} h`) : `${mins} min`;
}

/** "shop_uploads" → "uploads". */
export const shortVolume = (volume: string, stack: string): string => (volume.startsWith(`${stack}_`) ? volume.slice(stack.length + 1) : volume);

/** What a part is called in the sentence: "files" / "the database" when it's the only one of its kind, else its name. */
function noun(part: AppRestorePart, parts: AppRestorePart[], stack: string): string {
  const alone = parts.filter((p) => p.kind === part.kind).length === 1;
  if (part.kind === 'volume') return alone ? 'files' : shortVolume(part.name, stack);
  return alone ? 'the database' : part.name;
}

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** "Files from 14:00, the database from 14:02." — or "Everything from 14:00." when they land within a minute. */
export function skewSentence(plan: AppRestorePlan, stack: string): string {
  const { parts } = plan;
  if (parts.length === 0) return '';
  if (plan.skewMs < 60_000) return `Everything from ${whenLabel(parts[0]!.at, plan.at)}.`;
  const ordered = [...parts].sort((a, b) => a.at - b.at);
  return `${capital(ordered.map((p) => `${noun(p, parts, stack)} from ${whenLabel(p.at, plan.at)}`).join(', '))}.`;
}

/** How one part gets there: "the save of 13:58, 2 min before" · "replayed to 14:00 exactly". */
export function partWords(part: AppRestorePart, head: number): string {
  const when = whenLabel(part.at, head);
  const gap = part.behindMs >= 60_000 ? `, ${spanWords(part.behindMs)} before` : '';
  if (part.method === 'pitr') return part.behindMs < 60_000 ? `replayed to ${when} exactly` : `replayed to ${when}, the newest it can reach${gap}`;
  return `the save of ${when}${gap}`;
}

/** "only goes back to Wed 23 · 03:00" · "has no save yet". */
export function refusalWords(r: AppRestoreRefusal): string {
  return r.reachesFrom === null ? 'has no save yet' : `only goes back to ${momentLabel(r.reachesFrom)}`;
}

export const LEFT_OUT_WORDS: Record<AppRestoreLeftOutWhy, string> = {
  database: 'restored as its database',
  managed: 'a cache or search store, left as it is',
  global: 'runs on every server, so it can’t be paused',
};
