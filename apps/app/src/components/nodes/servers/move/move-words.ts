import { OLD_COPY_KEEP_DAYS } from '@swarmy/core';
import type { Tone } from '@/components/calm';
import { gb } from '../server-words';
import { FIT_WORD } from './fit-check';
import type { MovePlan, TargetPlan } from './use-move-plan';

/**
 * The move preview's words (board 9's verdict chip, title and body), pure.
 * Only what swarmy knows: memory now, and how the mover works — no time
 * estimates, no disk sizes.
 */

export interface Preview {
  tone: Tone;
  verdict: string;
  title: string;
  body: string;
  /** False when the move can't (or shouldn't) go ahead. */
  go: boolean;
}

const VERDICT_TONE = { fits: 'ok', tight: 'warn', 'wont-fit': 'bad', unknown: 'idle' } as const;

export function howItMoves(short: string, from: string, to: string): string {
  return `swarmy copies its data while ${short} keeps running, pauses it briefly for the last changes, checks the copy, then starts it on ${to}. The old copy stays on ${from} for ${OLD_COPY_KEEP_DAYS} days.`;
}

export function previewWords(o: { short: string; from: string; plan: MovePlan; target: TargetPlan }): Preview {
  const { short, from, plan, target: t } = o;
  const other = plan.best && plan.best.id !== t.id ? plan.best : null;
  if (plan.block) return { tone: 'bad', verdict: 'Can’t move', title: plan.block, body: '', go: false };
  if (t.block) return { tone: 'bad', verdict: 'Can’t move there', title: t.block, body: other ? `Try ${other.name}.` : '', go: false };
  const f = t.fit;
  const base = { tone: VERDICT_TONE[f.verdict] as Tone, verdict: FIT_WORD[f.verdict] };
  switch (f.verdict) {
    case 'fits':
      return { ...base, title: `Move ${short} to ${t.name}?`, body: howItMoves(short, from, t.name), go: true };
    case 'tight':
      return {
        ...base,
        title: `${t.name} would be nearly full`,
        body: `It fits, but ${t.name} would use ${f.afterPct}% of its memory.${other ? ` ${other.name} has more room.` : ''}`,
        go: true,
      };
    case 'wont-fit':
      return {
        ...base,
        title: `${t.name} would run out of memory`,
        body: `${short} uses about ${gb(f.needBytes)}; ${t.name} has ${gb(f.freeBytes)} free. ${other ? `Try ${other.name}.` : 'Add a server, or free some memory first.'}`,
        go: false,
      };
    case 'unknown':
      return {
        ...base,
        title: `Move ${short} to ${t.name}?`,
        body:
          f.beforePct === null
            ? `${t.name} isn’t reporting its memory right now, so swarmy can’t check the fit.`
            : `swarmy has no memory reading for ${short} yet, so it can’t check the fit. ${howItMoves(short, from, t.name)}`,
        go: f.beforePct !== null,
      };
  }
}
