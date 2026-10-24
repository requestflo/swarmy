/**
 * Restore as a copy INTO a database another flow just created — a cloned
 * environment's own Postgres, which its plan provisions in its own stack.
 * The choice of save is `restoreDbAsCopy`'s: the newest backup's engine, its
 * newest restorable save for a logical engine (`latestRestorable`), or
 * point-in-time to the latest for a physical one. Then the ordinary
 * `restoreDb` loads it and writes its own `db.restore` row. The source is
 * only read; nothing about it changes.
 */
import { isPhysicalEngine, type DbBackupEngine } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { commandRejected } from '../errors';
import { listDbBackups, restoreDb } from './dbBackup.service';
import { latestRestorable } from './dbRestoreSafety.service';

export interface RestoreIntoInput {
  /** The source cluster whose newest backup is copied. */
  stack: string;
  cluster: string;
  /** The already-provisioned, empty database that receives the copy. */
  targetStack: string;
  targetCluster: string;
}

export interface RestoreIntoResult {
  engine: DbBackupEngine;
  mode: 'clone-to-new-cluster' | 'pitr';
  /** The save loaded (null for point-in-time). */
  snapshotId: string | null;
}

export async function restoreNewestInto(ctx: OrgContext, input: RestoreIntoInput): Promise<RestoreIntoResult> {
  const ref = `${input.stack}/${input.cluster}`;
  const saves = await listDbBackups(ctx, { stack: input.stack, cluster: input.cluster });
  const newest = [...saves].sort((a, b) => b.time.localeCompare(a.time))[0];
  if (!newest) throw commandRejected(`${ref} has no backup yet — run a database backup there first, or start with an empty database`);
  const engine: DbBackupEngine = newest.engine === 'snapshot-from-replica' || !newest.engine ? 'pg_dump' : newest.engine;
  const mode = isPhysicalEngine(engine) ? 'pitr' : 'clone-to-new-cluster';
  const snapshotId = mode === 'pitr' ? null : (latestRestorable(saves, engine) ?? newest.id);
  await restoreDb(ctx, {
    stack: input.stack,
    cluster: input.cluster,
    engine,
    mode,
    ...(snapshotId ? { snapshotId } : {}),
    targetStack: input.targetStack,
    targetCluster: input.targetCluster,
  });
  return { engine, mode, snapshotId };
}
