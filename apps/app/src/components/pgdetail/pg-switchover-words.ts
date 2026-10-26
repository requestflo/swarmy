import type { DbSwitchoverRunView, SwitchoverStepStatus } from '@swarmy/core';
import type { Tone } from '@/components/calm';

/**
 * The progress card's words (a planned switchover's run, `db.switchoverRun`).
 * PURE — tested in pg-switchover.test.ts.
 */

export const STEP_TONE: Record<SwitchoverStepStatus, Tone> = { pending: 'idle', running: 'info', done: 'ok', warn: 'warn', failed: 'bad' };
export const STEP_WORD: Record<SwitchoverStepStatus, string> = { pending: 'next', running: 'now', done: 'done', warn: 'settling', failed: 'stopped' };

const sentence = (s: string): string => {
  const t = s.trim();
  if (!t) return t;
  const up = `${t[0]!.toUpperCase()}${t.slice(1)}`;
  return /[.!?]$/.test(up) ? up : `${up}.`;
};

export interface RunWords {
  tone: Tone;
  lead: string;
  rest: string;
}

export function runWords(run: DbSwitchoverRunView, copyName: (service: string) => string): RunWords {
  const to = copyName(run.target);
  if (run.status === 'running') {
    const now = run.steps.find((s) => s.status === 'running');
    return { tone: 'info', lead: `Making ${to} the writer.`, rest: now ? `Now: ${now.label.toLowerCase()}.` : 'Starting.' };
  }
  if (run.status === 'aborted') {
    return { tone: 'warn', lead: 'Nothing was switched.', rest: `${sentence(run.error ?? 'It stopped')} ${copyName(run.from)} kept the writes.` };
  }
  const settling = run.steps.some((s) => s.status === 'warn');
  const paused = run.pausedSeconds === null ? 'Writes paused for a few seconds' : `Writes paused for ${run.pausedSeconds} s`;
  return {
    tone: 'ok',
    lead: `${to} is the writer.`,
    rest: `${paused}; nothing was lost.${settling ? ` ${copyName(run.from)} is still catching up as a standby.` : ''}`,
  };
}

/**
 * The apps a switch-over restarts (the plan's `restarts`: wired straight to
 * the main copy, not through the pooler), in a sentence; null when none.
 */
export function restartWords(apps: readonly string[]): string | null {
  if (apps.length === 0) return null;
  const names = apps.length === 1 ? apps[0]! : `${apps.slice(0, -1).join(', ')} and ${apps[apps.length - 1]}`;
  return apps.length === 1
    ? `${names} connects straight to the main copy, so it restarts onto the new writer.`
    : `${names} connect straight to the main copy, so they restart onto the new writer.`;
}
