/**
 * Live restore progress (board 40: "Restoring … base backup ✓ · replaying
 * WAL to 13:05…"), the drill relay's idea for database restores.
 *
 * An in-memory relay keyed by the SOURCE cluster, so the restore card of the
 * database being restored from shows it, whether it lands in place or in a
 * copy. The restore code moves it through its steps (`stage`), the agent's
 * `running` progress frames fill in bytes and WAL segments (`agent`, via the
 * dispatch's `onProgress`), and the PITR wait reports how far the server
 * has replayed (`replay`). `dbBackups.restoreProgress` reads the latest run.
 * A finished run lingers a minute so the card shows how it ended; nothing is
 * stored (the restore's record is its `db.restore` audit row).
 */
import type { DbRestoreProgressView, DbRestoreStage } from '@swarmy/core';
import type { CommandProgress } from '@swarmy/core/protocol';

/** A finished run stays visible this long. */
const LINGER_MS = 60_000;
/** A run nobody finished (a crash mid-restore) is dropped after this. */
const ABANDON_MS = 6 * 3_600_000;

/** The restore's handle on its run. Calls after `finish` are ignored. */
export interface RestoreRun {
  stage(stage: DbRestoreStage): void;
  agent(progress: CommandProgress): void;
  replay(at: string): void;
  finish(ok: boolean, error?: string): void;
}

export interface RestoreRunMeta {
  into: string;
  mode: DbRestoreProgressView['mode'];
  engine: string;
  targetTime?: string;
}

const NUMBERS = { bytesDone: null, bytesTotal: null, percent: null, segments: null } as const;

export class RestoreProgressRelay {
  private runs = new Map<string, { view: DbRestoreProgressView; endedAt: number | null }>();
  constructor(private now: () => number = Date.now) {}

  begin(orgId: string, ref: string, meta: RestoreRunMeta): RestoreRun {
    this.sweep();
    const run = {
      view: {
        ref, into: meta.into, mode: meta.mode, engine: meta.engine, targetTime: meta.targetTime ?? null,
        startedAt: this.now(), endedAt: null, status: 'running', error: null, done: [], current: null,
        ...NUMBERS, replayedTo: null,
      } as DbRestoreProgressView,
      endedAt: null as number | null,
    };
    this.runs.set(`${orgId}\u0000${ref}`, run);
    const patch = (p: Partial<DbRestoreProgressView>): void => {
      if (run.endedAt == null) run.view = { ...run.view, ...p };
    };
    const stage = (s: DbRestoreStage): void => {
      const cur = run.view.current;
      if (cur?.stage === s) return;
      const t = this.now();
      patch({
        done: cur ? [...run.view.done, { stage: cur.stage, startedAt: cur.startedAt, endedAt: t }] : run.view.done,
        current: { stage: s, startedAt: t },
        ...NUMBERS,
      });
    };
    return {
      stage,
      agent: (p) => {
        const r = p.restore;
        if (p.phase !== 'restoring' || !r) return;
        stage(r.stage);
        patch({
          ...(r.bytesDone != null ? { bytesDone: r.bytesDone } : {}),
          ...(r.bytesTotal != null ? { bytesTotal: r.bytesTotal } : {}),
          ...(r.percent != null ? { percent: r.percent } : {}),
          ...(r.segments != null ? { segments: r.segments } : {}),
        });
      },
      replay: (at) => patch({ replayedTo: at }),
      finish: (ok, error) => {
        if (run.endedAt != null) return;
        const t = this.now();
        const cur = run.view.current;
        patch({
          status: ok ? 'succeeded' : 'failed',
          error: ok ? null : (error ?? 'the restore failed'),
          endedAt: t,
          ...(ok && cur ? { done: [...run.view.done, { stage: cur.stage, startedAt: cur.startedAt, endedAt: t }], current: null } : {}),
        });
        run.endedAt = t;
      },
    };
  }

  /** The cluster's run in flight (or finished within the minute), else null. */
  latest(orgId: string, ref: string): DbRestoreProgressView | null {
    this.sweep();
    return this.runs.get(`${orgId}\u0000${ref}`)?.view ?? null;
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, r] of this.runs) {
      if ((r.endedAt != null && t - r.endedAt > LINGER_MS) || t - r.view.startedAt > ABANDON_MS) this.runs.delete(k);
    }
  }
}

/** The process-wide relay. */
export const restoreProgress = new RestoreProgressRelay();
