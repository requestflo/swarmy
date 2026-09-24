/**
 * Backup schedule + DR restore-operation read/CRUD service
 * (epic: volumes-dr, P2 — scheduler + restore-on-recovery surfacing).
 *
 * Schedules drive the `backup-scheduler` worker. There is no stored run state:
 * `lastRunAt` is the schedule's newest `BackupJob`, and `nextRunAt` is computed
 * from the interval (`nextIntervalRun`). Restore
 * operations are written by the `dr-reconcile` worker and surfaced here for the
 * DR settings UI. Models (`BackupSchedule`, `BackupJob`, `RestoreOperation`)
 * are added to Prisma as part of this epic (see INTEGRATION).
 */
import { backupSchedules } from './backups.repo';
import type { OrgContext } from '../context';
import { badRequest, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { intervalMs, nextIntervalRun, type IntervalUnit, type ScheduleSpec } from './schedule';

export interface BackupScheduleView {
  id: string;
  targetId: string;
  /** Second destination each run also copies to (null = one copy). */
  secondaryTargetId: string | null;
  volume: string;
  nodeId: string | null;
  every: number;
  unit: IntervalUnit;
  paused: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  /** Created by default-on DB backups ("Auto — nightly, keep 7"), not a user. */
  auto: boolean;
  /** Retention this schedule prunes to when the stack has no retention label. */
  retentionDays: number | null;
}

interface ScheduleRow {
  id: string;
  targetId: string;
  secondaryTargetId?: string | null;
  volume: string;
  nodeId: string | null;
  every: number;
  unit: string;
  paused: boolean;
  createdAt: Date;
  anchorAt?: Date | null;
  auto?: boolean;
  retentionDays?: number | null;
  optedOutAt?: Date | null;
}

function db(ctx: OrgContext): {
  findMany(a: unknown): Promise<ScheduleRow[]>;
  findFirst(a: unknown): Promise<ScheduleRow | null>;
  create(a: unknown): Promise<ScheduleRow>;
  update(a: unknown): Promise<ScheduleRow>;
  delete(a: unknown): Promise<ScheduleRow>;
} {
  // Schedules live in the org's swarm (swarm-kv `bkp-sched`); run times derive from BackupJob.
  return backupSchedules(ctx, ctx.activeOrgId) as never;
}

/** Newest run per schedule, derived from `BackupJob` history in one query. */
export async function lastRunBySchedule(
  dbc: OrgContext['db'],
  scheduleIds: string[],
): Promise<Map<string, Date>> {
  if (scheduleIds.length === 0) return new Map();
  const rows = await dbc.backupJob.groupBy({
    by: ['scheduleId'],
    where: { scheduleId: { in: scheduleIds } },
    _max: { startedAt: true },
  });
  const out = new Map<string, Date>();
  for (const r of rows) if (r.scheduleId && r._max.startedAt) out.set(r.scheduleId, r._max.startedAt);
  return out;
}

/** The derived next run of a schedule row (null for a bad interval). */
export function scheduleNextRunAt(
  row: Pick<ScheduleRow, 'every' | 'unit' | 'createdAt' | 'anchorAt'>,
  lastRunAt: Date | null,
): Date | null {
  try {
    const spec: ScheduleSpec = { every: row.every, unit: row.unit as IntervalUnit };
    return nextIntervalRun(spec, row.anchorAt ?? row.createdAt, row.createdAt, lastRunAt);
  } catch {
    return null;
  }
}

function toView(row: ScheduleRow, lastRunAt: Date | null = null): BackupScheduleView {
  const nextRunAt = scheduleNextRunAt(row, lastRunAt);
  return {
    id: row.id,
    targetId: row.targetId,
    secondaryTargetId: row.secondaryTargetId ?? null,
    volume: row.volume,
    nodeId: row.nodeId,
    every: row.every,
    unit: row.unit as IntervalUnit,
    paused: row.paused,
    lastRunAt: lastRunAt ? lastRunAt.toISOString() : null,
    nextRunAt: nextRunAt ? nextRunAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    auto: row.auto === true,
    retentionDays: row.retentionDays ?? null,
  };
}

export async function listSchedules(
  ctx: OrgContext,
  input?: { stack?: string },
): Promise<BackupScheduleView[]> {
  const rows = await db(ctx).findMany({
    where: {
      orgId: ctx.activeOrgId,
      // Opt-out tombstones (a removed auto schedule) are not schedules.
      optedOutAt: null,
      // Volumes belong to a stack by name prefix (`<stack>_<volume>`).
      ...(input?.stack ? { volume: { startsWith: `${input.stack}_` } } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
  const last = await lastRunBySchedule(ctx.db, rows.map((r) => r.id));
  return rows.map((r) => toView(r, last.get(r.id) ?? null));
}

export interface CreateScheduleInput {
  targetId: string;
  secondaryTargetId?: string | null;
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
  if (input.secondaryTargetId && input.secondaryTargetId === input.targetId) {
    throw badRequest('The second destination must differ from the first.');
  }
  const now = new Date();
  // The user is taking over this volume: retire the auto schedule as an
  // opt-out tombstone (so the loop doesn't re-create it next to theirs).
  const auto = await db(ctx).findFirst({
    where: { orgId: ctx.activeOrgId, volume: input.volume, auto: true, optedOutAt: null },
  });
  if (auto) {
    await db(ctx).update({ where: { id: auto.id }, data: { optedOutAt: now, paused: true } });
  }
  const row = await db(ctx).create({
    data: {
      orgId: ctx.activeOrgId,
      targetId: input.targetId,
      secondaryTargetId: input.secondaryTargetId ?? null,
      volume: input.volume,
      nodeId: input.nodeId ?? null,
      every: input.every,
      unit: input.unit,
      paused: false,
    },
  });
  await writeAudit(ctx, {
    action: 'backup.schedule.create',
    targetType: 'backupSchedule',
    targetId: row.id,
    metadata: {
      volume: input.volume,
      every: input.every,
      unit: input.unit,
      ...(input.secondaryTargetId ? { secondaryTargetId: input.secondaryTargetId } : {}),
    },
  });
  return toView(row);
}

/** Add, change or drop a schedule's second destination (its off-site copy). */
export async function setScheduleSecondary(
  ctx: OrgContext,
  input: { id: string; secondaryTargetId: string | null },
): Promise<BackupScheduleView> {
  const row = await db(ctx).findFirst({ where: { id: input.id, orgId: ctx.activeOrgId, optedOutAt: null } });
  if (!row) throw notFound('backup schedule', input.id);
  if (input.secondaryTargetId && input.secondaryTargetId === row.targetId) {
    throw badRequest('The second destination must differ from the first.');
  }
  const updated = await db(ctx).update({
    where: { id: input.id },
    data: { secondaryTargetId: input.secondaryTargetId },
  });
  const last = await lastRunBySchedule(ctx.db, [input.id]);
  await writeAudit(ctx, {
    action: 'backup.schedule.secondary',
    targetType: 'backupSchedule',
    targetId: input.id,
    metadata: { secondaryTargetId: input.secondaryTargetId },
  });
  return toView(updated, last.get(input.id) ?? null);
}

export async function setSchedulePaused(
  ctx: OrgContext,
  input: { id: string; paused: boolean },
): Promise<BackupScheduleView> {
  const row = await db(ctx).findFirst({ where: { id: input.id, orgId: ctx.activeOrgId } });
  if (!row) throw notFound('backup schedule', input.id);
  const updated = await db(ctx).update({ where: { id: input.id }, data: { paused: input.paused } });
  const last = await lastRunBySchedule(ctx.db, [input.id]);
  await writeAudit(ctx, {
    action: input.paused ? 'backup.schedule.pause' : 'backup.schedule.resume',
    targetType: 'backupSchedule',
    targetId: input.id,
  });
  return toView(updated, last.get(input.id) ?? null);
}

export async function removeSchedule(
  ctx: OrgContext,
  id: string,
): Promise<{ id: string; removed: true }> {
  const row = await db(ctx).findFirst({ where: { id, orgId: ctx.activeOrgId, optedOutAt: null } });
  if (!row) throw notFound('backup schedule', id);
  if (row.auto) {
    // Removing an AUTO schedule is the user opting this volume out of
    // default-on backups: keep an inert tombstone (never runs, hidden from
    // lists) so the auto-backup loop does not re-create it.
    await db(ctx).update({ where: { id }, data: { optedOutAt: new Date(), paused: true } });
  } else {
    await db(ctx).delete({ where: { id } });
    // Job history keeps its rows; the link goes (the old FK's SetNull).
    await ctx.db.backupJob.updateMany({ where: { scheduleId: id }, data: { scheduleId: null } }).catch(() => undefined);
  }
  await writeAudit(ctx, {
    action: 'backup.schedule.remove',
    targetType: 'backupSchedule',
    targetId: id,
    metadata: { volume: row.volume, ...(row.auto ? { auto: true, optOut: true } : {}) },
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

export async function listRestoreOperations(
  ctx: OrgContext,
  input?: { stack?: string },
): Promise<RestoreOperationView[]> {
  const handle = (ctx.db as unknown as {
    restoreOperation: { findMany(a: unknown): Promise<RestoreRow[]> };
  }).restoreOperation;
  const rows = await handle.findMany({
    where: {
      orgId: ctx.activeOrgId,
      ...(input?.stack ? { targetVolume: { startsWith: `${input.stack}_` } } : {}),
    },
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
