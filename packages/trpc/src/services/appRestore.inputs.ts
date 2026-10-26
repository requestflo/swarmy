/**
 * Whole-app restore, the controller's own reads for the plan. The dashboard
 * plans from the lists it already shows; before anything is touched the
 * controller plans again from these: each volume's newest save at or before
 * T and its oldest (from the catalogue), each database's saves (the restic
 * catalogue) and its recoverable window (read from the WAL repo by its agent
 * when it can, else the schedule's estimate).
 */
import { isPhysicalEngine } from '@swarmy/core/protocol';
import type { AppRestoreDbIn, AppRestoreScopeView, AppRestoreVolumeIn } from '@swarmy/core';
import type { OrgContext } from '../context';
import { dbBackupOverview, getDbPitrWindow, listDbBackups } from './dbBackup.service';

/** Where a volume's saves live and which server holds it (its newest save's host). */
export interface VolumeFacts {
  /** snapshot id → destination, for the safety copy and the restore. */
  targets: Map<string, string>;
  /** The server its newest save ran on. */
  newestHost: string | null;
}

export interface PlanInputs {
  volumes: AppRestoreVolumeIn[];
  databases: AppRestoreDbIn[];
  facts: Map<string, VolumeFacts>;
}

async function volumeInput(ctx: OrgContext, volume: string, at: number): Promise<{ input: AppRestoreVolumeIn; facts: VolumeFacts }> {
  const where = { orgId: ctx.activeOrgId, volume, status: 'SUCCEEDED' as const };
  const [point, oldest, newest] = await Promise.all([
    ctx.db.snapshot.findFirst({ where: { ...where, startedAt: { lte: new Date(at) } }, orderBy: { startedAt: 'desc' } }),
    ctx.db.snapshot.findFirst({ where, orderBy: { startedAt: 'asc' } }),
    ctx.db.snapshot.findFirst({ where, orderBy: { startedAt: 'desc' } }),
  ]);
  const rows = [point, oldest].filter((r): r is NonNullable<typeof r> => Boolean(r));
  return {
    input: { volume, saves: rows.map((r) => ({ id: r.id, status: String(r.status), startedAt: r.startedAt.toISOString() })) },
    facts: { targets: new Map(rows.map((r) => [r.id, r.targetId])), newestHost: newest?.hostNodeId ?? null },
  };
}

async function dbInput(ctx: OrgContext, stack: string, cluster: string, row: Awaited<ReturnType<typeof dbBackupOverview>>[number] | undefined): Promise<AppRestoreDbIn> {
  const saves = await listDbBackups(ctx, { stack, cluster });
  const engine = row?.engine ?? null;
  if (!row?.pitr || !engine || !isPhysicalEngine(engine)) return { cluster, saves, pitr: null };
  const read = await getDbPitrWindow(ctx, { stack, cluster }).catch(() => null);
  const window = read?.source === 'agent' ? read.window : row.pitrWindow;
  return { cluster, saves, pitr: { engine, window } };
}

/** The plan's inputs for `scope` at T. */
export async function gatherPlanInputs(ctx: OrgContext, scope: AppRestoreScopeView, at: number): Promise<PlanInputs> {
  const vols = await Promise.all(scope.volumes.map((v) => volumeInput(ctx, v, at)));
  const overview = scope.databases.length ? await dbBackupOverview(ctx) : [];
  const databases = await Promise.all(
    scope.databases.map((c) => dbInput(ctx, scope.stack, c, overview.find((r) => r.stack === scope.stack && r.cluster === c))),
  );
  return {
    volumes: vols.map((v) => v.input),
    databases,
    facts: new Map(vols.map((v) => [v.input.volume, v.facts])),
  };
}
