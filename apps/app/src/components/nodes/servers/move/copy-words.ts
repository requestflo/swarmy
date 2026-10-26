import type { Tone } from '@/components/calm';
import { gb } from '../server-words';
import { FIT_WORD, type Fit } from './fit-check';

/**
 * Board 9's ⌥-drag preview words, pure: the controller's answer
 * (`services.copyPlan`: would Swarm start one more copy on that server?)
 * plus the one copy's memory against the server's. Only what swarmy knows.
 */

/** What `services.copyPlan` answers (the `@swarmy/core` `AddCopyPlan`). */
export type CopyAnswer = { ok: false; reason: string } | { ok: true; replicas: number; body: string; note: string | null };

export interface CopyPreview {
  tone: Tone;
  verdict: string;
  title: string;
  body: string;
  /** False when the copy can't (or shouldn't) be added. */
  go: boolean;
}

const VERDICT_TONE = { fits: 'ok', tight: 'warn', 'wont-fit': 'bad', unknown: 'idle' } as const;

export function copyWords(o: { short: string; target: string; answer: CopyAnswer | undefined; failed: string | null; fit: Fit }): CopyPreview {
  const { short, target: t, answer: a, fit } = o;
  const ask = `Add a copy of ${short} on ${t}?`;
  if (o.failed) return { tone: 'bad', verdict: 'Can’t check', title: `swarmy couldn’t check where a copy of ${short} would start.`, body: o.failed, go: false };
  if (!a) return { tone: 'idle', verdict: 'Checking', title: ask, body: 'Checking where Swarm would start it…', go: false };
  if (!a.ok) return { tone: 'bad', verdict: 'Can’t add it there', title: a.reason, body: '', go: false };
  if (fit.verdict === 'wont-fit') {
    return { tone: 'bad', verdict: FIT_WORD[fit.verdict], title: `${t} would run out of memory`, body: `A copy of ${short} uses about ${gb(fit.needBytes)}; ${t} has ${gb(fit.freeBytes)} free.`, go: false };
  }
  const tight = fit.verdict === 'tight' ? ` ${t} would use ${fit.afterPct}% of its memory.` : '';
  const unknown = fit.verdict === 'unknown' ? ` swarmy can’t check the memory fit yet.` : '';
  return { tone: VERDICT_TONE[fit.verdict], verdict: FIT_WORD[fit.verdict], title: ask, body: `${a.body}${a.note ? ` ${a.note}` : ''}${tight}${unknown}`, go: true };
}
