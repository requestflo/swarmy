/**
 * Whole-app restore, the controller's plain words (PURE): why a restore was
 * refused before anything was touched, and what a failed one did.
 */
import type { AppRestorePlan } from '@swarmy/core';
import type { AppRestoreRun } from './appRestore.run';

/** "2026-10-22 14:00 UTC". */
export function utcMinute(t: number): string {
  return `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

const list = (names: string[]): string =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/** Why the plan can't run: nothing saved, or parts that can't go back that far. */
export function refusalWords(stack: string, plan: AppRestorePlan): string {
  if (plan.parts.length === 0 && plan.refused.length === 0) return `${stack} has no saved volumes or databases to restore.`;
  const why = plan.refused.map((r) =>
    r.reachesFrom === null ? `${r.name} has no save yet` : `${r.name} only goes back to ${utcMinute(r.reachesFrom)}`,
  );
  const later = plan.reachesFrom !== null ? ` Every part reaches back to ${utcMinute(plan.reachesFrom)}.` : '';
  return `Nothing was restored: ${list(why)}, so ${stack} can't all go back to ${utcMinute(plan.at)}.${later}`;
}

/** What a failed run did: which part failed, which were put back, and whether the app is running. */
export function failureWords(stack: string, run: AppRestoreRun): string {
  const failed = run.parts.find((p) => p.status === 'failed');
  const out = [`Restoring ${failed?.name ?? stack} failed: ${failed?.error ?? run.error ?? 'unknown error'}.`];
  const back = run.parts.filter((p) => p.undo === 'done').map((p) => p.name);
  if (back.length) out.push(`${list(back)} ${back.length === 1 ? 'was' : 'were'} put back from the copy saved first.`);
  for (const p of run.parts.filter((x) => x.undo === 'failed')) {
    out.push(`Putting ${p.name} back failed (${p.undoError}); its saved copy is ${p.safetySnapshotId}, on the Backups tab.`);
  }
  out.push(run.startError ? `${stack}: ${run.startError}.` : `${stack} was started again.`);
  return out.join(' ');
}
