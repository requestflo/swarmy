/**
 * "Restore as a copy" (Time travel, the Postgres backups board): create a NEW
 * managed Postgres beside the original and restore into it. Nothing live
 * changes until the person switches the app to the copy, or removes it.
 *
 * The copy is `<cluster>-restore-<mmdd>` (`restoreCopyName`, which the
 * dashboard uses too, so it can name it up front). It goes through the normal
 * provision path with the source's image (same engine and version) and
 * database, ONE copy (`single`, no standby) and the same placement rules
 * (`copyPinNode`). It is wired into no app. Once Postgres answers, the
 * ordinary `restoreDb` loads it (a logical clone, or point-in-time for a
 * physical engine) and writes its own `db.restore` row; this adds one
 * `db.restore.copy` row saying which copy came from where.
 *
 * Preconditions THROW before anything exists (no source, the name is taken,
 * nothing to restore). After that, a failure removes the copy's services by
 * name, like the restore drill. Its volume is kept: a same-named volume can
 * hold an earlier copy removed with "keep the data". A copy that worked is
 * removed with `db.remove`, from the dashboard.
 */
import { buildInventory, PG_ENV, restoreCopyName, type InvService } from '@swarmy/core';
import { isPhysicalEngine, type DbBackupEngine } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { commandRejected, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { listDbBackups, restoreDb, type DbRestoreRunView } from './dbBackup.service';
import { copyPinNode } from './dbRestoreCopy.placement';
import { latestRestorable } from './dbRestoreSafety.service';
import { resolveManagerNode } from './dispatch.service';
import {
  DB_CLUSTER_LABEL,
  DB_MEMBER_LABEL,
  DB_ROLE_LABEL,
  primaryServiceName,
  provisionDbWithPassword,
  replicaServiceName,
  resolveManagedPgImage,
} from './manageddb.service';
import { waitForPostgres } from './resilience.service';

export const RESTORE_COPY_AUDIT_ACTION = 'db.restore.copy';

export interface RestoreDbAsCopyInput {
  stack: string;
  cluster: string;
  engine: DbBackupEngine;
  targetId?: string;
  /** Logical: the save to load (default the newest this engine can load). */
  snapshotId?: string;
  /** Physical engines: the moment to recover to (default the latest). */
  targetTime?: string;
  /** The copy's name as the dashboard showed it; must be free. Default {@link restoreCopyName}. */
  name?: string;
}

export interface DbRestoreCopyView extends DbRestoreRunView {
  copy: { stack: string; cluster: string; primaryService: string; rwHost: string };
}

function envValue(s: InvService, key: string): string | undefined {
  const kv = s.env.find((e) => e.startsWith(`${key}=`));
  return kv ? kv.slice(key.length + 1) : undefined;
}

/** The source primary plus every cluster name the stack already uses. */
function lookup(ctx: OrgContext, stack: string, cluster: string): { source?: InvService; taken: Set<string> } {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  const dbs = buildInventory(services, containers).services.filter((s) => s.stack === stack && s.labels[DB_CLUSTER_LABEL]);
  return {
    source: dbs.find(
      (s) => s.labels[DB_CLUSTER_LABEL] === cluster && s.labels[DB_ROLE_LABEL] === 'primary' && !s.labels[DB_MEMBER_LABEL],
    ),
    taken: new Set(dbs.map((s) => s.labels[DB_CLUSTER_LABEL]!)),
  };
}

export async function restoreDbAsCopy(
  ctx: OrgContext,
  input: RestoreDbAsCopyInput,
  now: Date = new Date(),
): Promise<DbRestoreCopyView> {
  const { stack, cluster, engine } = input;
  const { source, taken } = lookup(ctx, stack, cluster);
  if (!source) throw notFound('db cluster primary', `${stack}/${cluster}`);
  const name = input.name?.trim() || restoreCopyName(cluster, now, taken);
  if (taken.has(name)) throw commandRejected(`${stack}/${name} already exists: a copy is always a new database`);
  const mode = isPhysicalEngine(engine) ? 'pitr' : 'clone-to-new-cluster';
  // A logical "latest" is pinned to a real save now, before anything is created.
  let snapshotId = input.snapshotId;
  if (mode !== 'pitr' && (!snapshotId || snapshotId.toLowerCase() === 'latest')) {
    const saves = await listDbBackups(ctx, { targetId: input.targetId, stack, cluster });
    snapshotId = latestRestorable(saves, engine) ?? undefined;
    if (!snapshotId) throw commandRejected(`there is no ${engine} backup of ${stack}/${cluster} to restore yet`);
  }

  const ref = `${stack}/${name}`;
  const audit = (metadata: Record<string, unknown>): Promise<void> =>
    writeAudit(ctx, {
      action: RESTORE_COPY_AUDIT_ACTION,
      actorType: ctx.user ? 'user' : 'system',
      targetType: 'dbCluster',
      targetId: ref,
      metadata: { source: `${stack}/${cluster}`, engine, mode, snapshotId: snapshotId ?? null, targetTime: input.targetTime ?? null, ...metadata },
    });
  const pinNode = copyPinNode(ctx, source.labels);
  try {
    // The password comes back because this is the server-side provision; it is dropped here.
    const { primaryService, rwHost } = await provisionDbWithPassword(
      ctx,
      {
        stack,
        name,
        replicas: 0,
        topology: 'single',
        image: resolveManagedPgImage({}, source.image),
        database: envValue(source, PG_ENV.database) || undefined,
      },
      pinNode ? { pinNode } : {},
    );
    await waitForPostgres(ctx, primaryService);
    const restored = await restoreDb(ctx, {
      stack,
      cluster,
      engine,
      mode,
      targetId: input.targetId,
      snapshotId,
      targetTime: input.targetTime,
      targetStack: stack,
      targetCluster: name,
    });
    await audit({ status: 'succeeded' });
    return { ...restored, copy: { stack, cluster: name, primaryService, rwHost } };
  } catch (e) {
    const removed = await removeCopyServices(ctx, stack, name);
    await audit({ status: 'failed', error: e instanceof Error ? e.message : String(e), removed });
    throw e;
  }
}

/** Best-effort: the copy's member services, by name. Returns the ones removed. */
async function removeCopyServices(ctx: OrgContext, stack: string, name: string): Promise<string[]> {
  const node = await resolveManagerNode(ctx).catch(() => null);
  if (!node) return [];
  const removed: string[] = [];
  for (const service of [primaryServiceName(stack, name), replicaServiceName(stack, name)]) {
    const ok = await ctx.hub.dispatch(node.id, 'service.remove', { service }).then(() => true, () => false);
    if (ok) removed.push(service);
  }
  return removed;
}
