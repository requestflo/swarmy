import { API_KEY_PRESETS, type ApiKeyPreset } from '@swarmy/core';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SOON = 30 * DAY;
const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];

/** "in 12 days" · "in 5 hours" · "in a minute"; a past date says so. */
export function untilWords(iso: string, now = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return 'already';
  if (ms < HOUR) return 'within the hour';
  if (ms < DAY) {
    const h = Math.round(ms / HOUR);
    return `in ${h} hour${h === 1 ? '' : 's'}`;
  }
  const d = Math.round(ms / DAY);
  return `in ${d} day${d === 1 ? '' : 's'}`;
}

/** Short mono form for rows: "5 d", "23 h". */
export function untilShort(iso: string, now = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return 'expired';
  if (ms < DAY) return `${Math.max(1, Math.round(ms / HOUR))} h`;
  return `${Math.round(ms / DAY)} d`;
}

export function countWord(n: number): string {
  return WORDS[n] ?? String(n);
}

interface KeyLike {
  status: string;
  expiresAt: string | null;
  preset: ApiKeyPreset | 'custom';
  scopes: string[];
  stackNames: string[] | null;
}

/** An active key that stops working within 30 days: it gets the warn tone. */
export function expiresSoon(k: Pick<KeyLike, 'status' | 'expiresAt'>, now = Date.now()): boolean {
  return k.status === 'active' && k.expiresAt !== null && new Date(k.expiresAt).getTime() - now < SOON;
}

/** The page's second clause: the next key to expire within 30 days, if any. */
export function soonestExpiry(keys: KeyLike[], now = Date.now()): string | null {
  const soon = keys
    .filter((k) => expiresSoon(k, now))
    .sort((a, b) => new Date(a.expiresAt ?? 0).getTime() - new Date(b.expiresAt ?? 0).getTime());
  if (soon.length === 0) return null;
  const first = soon[0]?.expiresAt as string;
  return soon.length === 1
    ? `One expires ${untilWords(first, now)}.`
    : `${countWord(soon.length)} expire soon, the first ${untilWords(first, now)}.`;
}

/** "Deploy" / "Read-only" / "Admin" / "read, write" for older keys. */
export function presetLabel(k: Pick<KeyLike, 'preset' | 'scopes'>): string {
  return k.preset === 'custom' ? k.scopes.join(', ') : API_KEY_PRESETS[k.preset].label;
}

export function appsLabel(stackNames: string[] | null): string {
  if (!stackNames) return 'every app';
  return stackNames.length > 2 ? `${stackNames.slice(0, 2).join(', ')} +${stackNames.length - 2}` : stackNames.join(', ');
}
