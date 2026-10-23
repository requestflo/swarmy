import type { ResilienceDrillResultView } from '@swarmy/core';
import { fmtBytes } from './backup-format';

/**
 * Plain words for the drill's recorded steps (`drillHistory[].steps`). The
 * service names them in its own terms ("Restore snapshot a1b2c3d4",
 * "Verify SELECT 1"); Summary reads these, the raw name is the Tech line.
 */
const STEP_WORDS: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^Create throwaway cluster/i, () => 'Start a throwaway copy'],
  [/^Wait for postgres/i, () => 'Wait for it to answer'],
  [/^Restore snapshot/i, () => 'Put the latest save into it'],
  [/^Verify SELECT 1/i, () => 'Check it answers'],
  [/^Destroy the clone/i, () => 'Delete the copy'],
  [/^restic check on "(.+)"/i, (m) => `Check every save in ${m[1]}`],
];

export function stepWords(name: string): string {
  for (const [re, say] of STEP_WORDS) {
    const m = re.exec(name);
    if (m) return say(m);
  }
  return name;
}

/** Bytes the restore step reported ("412331520 bytes restored"), or null. */
export function restoredBytes(r: ResilienceDrillResultView): string | null {
  for (const s of r.steps) {
    const m = /^(\d+) bytes restored/.exec(s.detail ?? '');
    if (m) return m[1]!;
  }
  return null;
}

/** "Restored 393.2 MB and it answered." / the step that failed. */
export function drillOutcome(r: ResilienceDrillResultView): string {
  if (r.status === 'failed') {
    const step = r.steps.find((s) => s.status === 'failed');
    return step ? `It stopped at “${stepWords(step.name).toLowerCase()}”. Nothing live was touched.` : 'It failed before it started. Nothing live was touched.';
  }
  const bytes = restoredBytes(r);
  return r.kind === 'restore'
    ? `Restored ${bytes ? fmtBytes(bytes) : 'the latest save'} and it answered.`
    : 'Every save in the destination is whole.';
}
