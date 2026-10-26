/**
 * Whole-app restore, the run: stop the app once, put each part back through
 * its own restore path with its own safety copy, and start the app again.
 *
 * Volumes go first (quick, and cheap to put back), then databases. If a part
 * fails, every part already written over is put back from the safety copy it
 * took, newest first, and so is the failing part when it was written to. A
 * point-in-time restore is the exception: its own path already puts the old
 * data back when it fails (dbPitrRestore.service). The app is started again
 * whatever happened.
 *
 * It is a compensating rollback, not a transaction: a controller restart in
 * the middle leaves the app stopped and the parts as far as they got, and
 * each safety copy stays in the catalogue (`reason:pre-restore` for a
 * database) to restore by hand.
 *
 * The steps are injected (bound in appRestore.service), so this is unit-tested.
 */
import type { AppRestorePart, AppRestorePartOutcome } from '@swarmy/core';

export interface AppRestoreSteps {
  /** Stop the app; throw (after starting it again) when it would not stop. */
  stop(): Promise<void>;
  /** Start the app again; an error message when some part of it did not start. */
  start(): Promise<string | null>;
  /** Save a volume as it is now; the catalogue id of the save. */
  saveVolume(part: AppRestorePart): Promise<string>;
  restoreVolume(part: AppRestorePart): Promise<void>;
  /** Restore a database; `onSafety` hears its safety copy as soon as it exists. */
  restoreDb(part: AppRestorePart, onSafety: (snapshotId: string) => void): Promise<void>;
  undoVolume(part: AppRestorePart, safetySnapshotId: string): Promise<void>;
  undoDb(part: AppRestorePart, safetySnapshotId: string): Promise<void>;
}

export interface AppRestoreRun {
  ok: boolean;
  parts: AppRestorePartOutcome[];
  /** The failing part's reason. */
  error?: string;
  /** Starting the app again failed. */
  startError?: string;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Volumes first, then databases; the plan's order within each. */
export function runOrder(parts: AppRestorePart[]): AppRestorePart[] {
  return [...parts.filter((p) => p.kind === 'volume'), ...parts.filter((p) => p.kind === 'database')];
}

/** Was this part written to, so that putting it back means restoring its safety copy? */
function touched(o: AppRestorePartOutcome): boolean {
  if (!o.safetySnapshotId) return false;
  if (o.status === 'restored') return true;
  return o.status === 'failed' && o.method !== 'pitr';
}

export async function runAppRestore(parts: AppRestorePart[], steps: AppRestoreSteps): Promise<AppRestoreRun> {
  const out: AppRestorePartOutcome[] = runOrder(parts).map((p) => ({ ...p, safetySnapshotId: null, status: 'skipped' }));
  await steps.stop();
  let error: string | undefined;
  for (const o of out) {
    try {
      if (o.kind === 'volume') {
        o.safetySnapshotId = await steps.saveVolume(o);
        await steps.restoreVolume(o);
      } else {
        await steps.restoreDb(o, (id) => {
          o.safetySnapshotId = id;
        });
      }
      o.status = 'restored';
    } catch (e) {
      o.status = 'failed';
      o.error = message(e);
      error = `${o.name}: ${o.error}`;
      break;
    }
  }
  if (error) {
    for (const o of [...out].reverse()) {
      if (!touched(o)) continue;
      try {
        if (o.kind === 'volume') await steps.undoVolume(o, o.safetySnapshotId!);
        else await steps.undoDb(o, o.safetySnapshotId!);
        o.undo = 'done';
      } catch (e) {
        o.undo = 'failed';
        o.undoError = message(e);
      }
    }
  }
  const startError = await steps.start().catch((e: unknown) => message(e));
  return { ok: !error, parts: out, ...(error ? { error } : {}), ...(startError ? { startError } : {}) };
}
