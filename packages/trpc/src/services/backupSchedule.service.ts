/**
 * Backup schedule + DR restore-operation read/CRUD service
 * (epic: volumes-dr, P2 — scheduler + restore-on-recovery surfacing).
 *
 * Schedules drive the `backup-scheduler` worker (it reads `nextRunAt`). Restore
 * operations are written by the `dr-reconcile` worker and surfaced here for the
 * DR settings UI. Models (`BackupSchedule`, `BackupJob`, `RestoreOperation`)
 * are added to Prisma as part of this epic (see INTEGRATION).
 */
import type { OrgContext } from '../context';
import { notFound } from '../errors';
import { writeAudit } from './audit.service';
import { intervalMs, nextRun, type IntervalUnit, type ScheduleSpec } from './schedule';

export interface BackupScheduleView {
  id: string;
  targetId: string;
  volume: string;
  nodeId: string | null;
  every: number;
  unit: IntervalUnit;
  paused: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
}

interface ScheduleRow {
  id: string;
  targetId: string;
  volume: string;
  nodeId: string | null;
  every: number;
  unit: string;
  paused: boolean;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  createdAt: Date;
}

function db(ctx: OrgContext): {
  findMany(a: unknown): Promise<ScheduleRow[]>;
  findFirst(a: unknown): Promise<ScheduleRow | null>;
  create(a: unknown): Promise<ScheduleRow>;
  update(a: unknown): Promise<ScheduleRow>;
  delete(a: unknown): Promise<ScheduleRow>;
} {
  return (ctx.db as unknown as { backupSchedule: ReturnType<typeof db> }).backupSchedule;
}

function toView(row: ScheduleRow): BackupScheduleView {
  return {
    id: row.id,
    targetId: row.targetId,
    volume: row.volume,
    nodeId: row.nodeId,
    every: row.every,
    unit: row.unit as IntervalUnit,
    paused: row.paused,
    lastRunAt: row.lastRunAt ? row.lastRunAt.toISOString() : null,
    nextRunAt: row.nextRunAt ? row.nextRunAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listSchedules(ctx: OrgContext): Promise<BackupScheduleView[]> {
  const rows = await db(ctx).findMany({
    where: { orgId: ctx.activeOrgId },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toView);
}

export interface CreateScheduleInput {
  targetId: string;
  volume: string;
  nodeId?: string;
  every: number;
  unit: IntervalUnit;
}

export async function createSchedule(
  ctx: OrgContext,
  input: CreateScheduleInput,
): Promise<BackupScheduleView> {
  const spec: ScheduleSpec = { every: input.every, unit: input.unit };
  intervalMs(spec); // validate
  const now = new Date();
  const row = await db(ctx).create({
    data: {
      orgId: ctx.activeOrgId,
      targetId: input.targetId,
      volume: input.volume,
      nodeId: input.nodeId ?? null,
      every: input.every,
      unit: input.unit,
      paused: false,
      nextRunAt: nextRun(spec, now, now),
    },
  });
  await writeAudit(ctx, {
    action: 'backup.schedule.create',
    targetType: 'backupSchedule',
    targetId: row.id,
    metadata: { volume: input.volume, every: input.every, unit: input.unit },
  });
  return toView(row);
}

export async function setSchedulePaused(
  ctx: OrgContext,
  input: { id: string; paused: boolean },
): Promise<BackupScheduleView> {
  const row = await db(ctx).findFirst({ where: { id: input.id, orgId: ctx.activeOrgId } });
  if (!row) throw notFound('backup schedule', input.id);
  const updated = await db(ctx).update({ where: { id: input.id }, data: { paused: input.paused } });
  await writeAudit(ctx, {
    action: input.paused ? 'backup.schedule.pause' : 'backup.schedule.resume',
    targetType: 'backupSchedule',
    targetId: input.id,
  });
  return toView(updated);
}

export async function removeSchedule(
  ctx: OrgContext,
  id: string,
): Promise<{ id: string; removed: true }> {
  const row = await db(ctx).findFirst({ where: { id, orgId: ctx.activeOrgId } });
  if (!row) throw notFound('backup schedule', id);
  await db(ctx).delete({ where: { id } });
  await writeAudit(ctx, {
    action: 'backup.schedule.remove',
    targetType: 'backupSchedule',
    targetId: id,
  });
  return { id, removed: true };
}

// ── restore operations (DR history) ──────────────────────────────────────────

export interface RestoreOperationView {
  id: string;
  snapshotId: string;
  targetVolume: string;
  targetNodeId: string | null;
  status: string;
  reason: string;
  bytesRestored: string | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

interface RestoreRow {
  id: string;
  snapshotId: string;
  targetVolume: string;
  targetNodeId: string | null;
  status: string;
  reason: string;
  bytesRestored: bigint | null;
  startedAt: Date;
  finishedAt: Date | null;
  error: string | null;
}

export async function listRestoreOperations(ctx: OrgContext): Promise<RestoreOperationView[]> {
  const handle = (ctx.db as unknown as {
    restoreOperation: { findMany(a: unknown): Promise<RestoreRow[]> };
  }).restoreOperation;
  const rows = await handle.findMany({
    where: { orgId: ctx.activeOrgId },
    orderBy: { startedAt: 'desc' },
    take: 100,
  });
  return rows.map((r) => ({
    id: r.id,
    snapshotId: r.snapshotId,
    targetVolume: r.targetVolume,
    targetNodeId: r.targetNodeId,
    status: r.status,
    reason: r.reason,
    bytesRestored: r.bytesRestored != null ? r.bytesRestored.toString() : null,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    error: r.error,
  }));
}
