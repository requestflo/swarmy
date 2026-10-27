/**
 * "Also copy to" on a managed-Postgres backup schedule (board 40): set or
 * drop the second destination, and list every cluster's copy for
 * `backups.copyLag`.
 *
 * Volume schedules keep `secondaryTargetId` on their swarm-kv row; a DB
 * schedule is the `swarmy.db.backup.schedule` label on the primary, so the
 * second destination is a field of that label (Docker truth, no column).
 */
import type { DbBackupCopyView, DbBackupScheduleView } from '@swarmy/core';
import type { OrgContext } from '../context';
import { badRequest, commandRejected, mapDispatchError, notFound } from '../errors';
import { writeAudit } from './audit.service';
import {
  DB_BACKUP_LAST_RUN_LABEL,
  DB_BACKUP_SCHEDULE_LABEL,
  clusterPrimaries,
  encodeScheduleLabel,
  findCluster,
  loadTarget,
  parseLastRunLabel,
  parseScheduleLabel,
  resolveTargetId,
  scheduleView,
} from './dbBackup.service';
import { copyMethod } from './dbBackupCopy.label';
import { copyFields } from './dbBackupCopy.read';
import { resolveManagerNode } from './dispatch.service';
import { DB_CLUSTER_LABEL } from './manageddb.service';

export interface SetDbBackupSecondaryInput {
  stack: string;
  cluster: string;
  /** null drops the second copy. */
  secondaryTargetId: string | null;
}

/** Add, change or drop a cluster schedule's second destination. */
export async function setDbBackupSecondary(ctx: OrgContext, input: SetDbBackupSecondaryInput): Promise<DbBackupScheduleView> {
  const { primary } = findCluster(ctx, input.stack, input.cluster);
  if (!primary) throw notFound('db cluster primary', input.cluster);
  const schedule = parseScheduleLabel(primary.labels[DB_BACKUP_SCHEDULE_LABEL]);
  if (!schedule) throw commandRejected(`Put ${input.cluster} on a schedule first: the second copy follows each save.`);
  const dest = input.secondaryTargetId;
  if (dest) {
    const t = await loadTarget(ctx, dest); // org-scope check
    if (dest === (await resolveTargetId(ctx, undefined, schedule))) throw badRequest('The second destination must differ from the first.');
    const method = copyMethod(schedule.engine);
    if (!method) {
      throw commandRejected(`A ${schedule.engine} schedule writes its backups to one place; swarmy can't copy them to a second destination.`);
    }
    if (method === 'walg-copy' && t.kind.toUpperCase() !== 'S3') throw commandRejected('wal-g copies into an S3 bucket only: pick an S3 destination for the second copy.');
  }
  const { secondaryTargetId: _drop, ...rest } = schedule;
  const next = dest ? { ...rest, secondaryTargetId: dest } : rest;
  try {
    const node = await resolveManagerNode(ctx);
    await ctx.hub.dispatch(node.id, 'service.updateLabels', {
      service: primary.name,
      add: { [DB_BACKUP_SCHEDULE_LABEL]: encodeScheduleLabel(next) },
      removeKeys: [],
    });
  } catch (e) {
    throw mapDispatchError(e);
  }
  await writeAudit(ctx, {
    action: 'db.backup.schedule.secondary',
    actorType: ctx.user ? 'user' : 'system',
    targetType: 'dbCluster',
    targetId: `${input.stack}/${input.cluster}`,
    metadata: { secondaryTargetId: dest },
  });
  return scheduleView(input.stack, input.cluster, next, parseLastRunLabel(primary.labels[DB_BACKUP_LAST_RUN_LABEL]), new Date());
}

/** Every cluster in the org whose schedule copies somewhere, with how far that copy trails. */
export function dbCopies(ctx: OrgContext, now = Date.now()): Array<{ ref: string; copy: DbBackupCopyView }> {
  const out: Array<{ ref: string; copy: DbBackupCopyView }> = [];
  for (const p of clusterPrimaries(ctx)) {
    const schedule = parseScheduleLabel(p.labels[DB_BACKUP_SCHEDULE_LABEL]);
    if (!schedule?.secondaryTargetId) continue;
    const ref = `${p.stack}/${p.labels[DB_CLUSTER_LABEL] ?? ''}`;
    const lastRun = parseLastRunLabel(p.labels[DB_BACKUP_LAST_RUN_LABEL]);
    const { copy } = copyFields({ orgId: ctx.activeOrgId, ref, labels: p.labels, schedule, lastRun, targetName: () => null, now });
    if (copy) out.push({ ref, copy });
  }
  return out;
}
