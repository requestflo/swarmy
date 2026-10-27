/**
 * How far behind each "also copy to" destination is (board 16's "Offsite
 * copy · 4 min behind").
 *
 * A volume schedule may name a second destination (`secondaryTargetId`):
 * every run backs the volume up to its primary destination, then again to
 * the second one (`backup-scheduler` `backupToTarget`), each catalogued as a
 * `Snapshot` row under its own target. So the copy's lag is read from those
 * rows, no agent command: per volume, the newest save on the primary against
 * the newest copy on the second destination (each as of when it started; a
 * copy that started after the save holds data at least as new). A copy that
 * never landed, one running now and one whose last try failed are counted
 * apart, so a nightly copy in flight never reads as "a day behind".
 *
 * Managed-Postgres schedules copy too (`dbBackupCopy.*`): their lag is read
 * off the primary's labels and folded in (`backupCopyLag.db.ts`).
 */
import type { OrgContext } from '../context';
import { foldDbCopies } from './backupCopyLag.db';
import { backupSchedules } from './backups.repo';
import { dbCopies } from './dbBackupCopy.service';

export interface BackupCopyLagView {
  /** The second destination. */
  targetId: string;
  /** Active schedules that copy here (volumes and databases). */
  schedules: number;
  /** How many of them are managed-Postgres schedules. */
  databases: number;
  /** The worst volume's lag (0 = in step); null while nothing has been saved and copied yet. */
  behindMs: number | null;
  /** The worst volume, or `<stack>/<cluster>` for a database. */
  worstVolume: string | null;
  /** Volumes saved on their primary destination but never copied here. */
  neverCopied: number;
  /** Volumes being copied right now. */
  copying: number;
  /** Volumes whose latest copy here failed, and the newest such error. */
  failing: number;
  lastError: string | null;
  newestCopyAt: string | null;
  /** The size of the newest copy of each volume, summed (what a restore from here reads). */
  copiedBytes: string;
}

interface Sched {
  volume: string;
  targetId: string;
  secondaryTargetId?: string | null;
}
export interface SnapRow {
  volume: string;
  targetId: string;
  status: string;
  startedAt: Date;
  sizeBytes: bigint | number | null;
  error: string | null;
}

/** PURE: the lag per second destination, from the schedules and their newest catalogue rows. */
export function copyLag(schedules: readonly Sched[], rows: readonly SnapRow[]): BackupCopyLagView[] {
  const key = (volume: string, targetId: string) => `${volume}\u0000${targetId}`;
  const newestOk = new Map<string, SnapRow>();
  const newestAny = new Map<string, SnapRow>();
  const keepNewer = (m: Map<string, SnapRow>, k: string, r: SnapRow): void => {
    const have = m.get(k);
    if (!have || r.startedAt.getTime() > have.startedAt.getTime()) m.set(k, r);
  };
  for (const r of rows) {
    const k = key(r.volume, r.targetId);
    if (r.status === 'SUCCEEDED') keepNewer(newestOk, k, r);
    if (r.status !== 'PRUNED') keepNewer(newestAny, k, r);
  }
  const out = new Map<string, BackupCopyLagView & { copied: bigint; errorAt: number }>();
  for (const s of schedules) {
    const dest = s.secondaryTargetId;
    if (!dest || dest === s.targetId) continue;
    const v = out.get(dest) ?? { targetId: dest, schedules: 0, databases: 0, behindMs: null, worstVolume: null, neverCopied: 0, copying: 0, failing: 0, lastError: null, newestCopyAt: null, copiedBytes: '0', copied: 0n, errorAt: 0 };
    out.set(dest, v);
    v.schedules += 1;
    const saved = newestOk.get(key(s.volume, s.targetId));
    const copy = newestOk.get(key(s.volume, dest));
    const last = newestAny.get(key(s.volume, dest));
    if (last?.status === 'RUNNING') v.copying += 1;
    if (last?.status === 'FAILED') {
      v.failing += 1;
      if (last.startedAt.getTime() > v.errorAt) [v.errorAt, v.lastError] = [last.startedAt.getTime(), last.error];
    }
    if (copy) {
      v.copied += BigInt(copy.sizeBytes ?? 0);
      if (!v.newestCopyAt || copy.startedAt.toISOString() > v.newestCopyAt) v.newestCopyAt = copy.startedAt.toISOString();
    }
    if (!saved) continue;
    if (!copy) {
      if (last?.status !== 'RUNNING') v.neverCopied += 1;
      continue;
    }
    const behind = last?.status === 'RUNNING' ? 0 : Math.max(0, saved.startedAt.getTime() - copy.startedAt.getTime());
    if (v.behindMs == null || behind > v.behindMs) [v.behindMs, v.worstVolume] = [behind, s.volume];
  }
  return [...out.values()].map(({ copied, errorAt: _e, ...v }) => ({ ...v, copiedBytes: String(copied) }));
}

/** How far back the catalogue is read: a copy older than this counts as never landed. */
const LOOKBACK_MS = 90 * 86_400_000;

/** `backups.copyLag`: every "also copy to" destination of the org's active schedules, volumes and databases. */
export async function getCopyLag(ctx: OrgContext, now = Date.now()): Promise<BackupCopyLagView[]> {
  const volumes = await volumeCopyLag(ctx, now);
  let dbs: ReturnType<typeof dbCopies> = [];
  try {
    dbs = dbCopies(ctx, now);
  } catch {
    // no live inventory (no connected manager): the volume rows stand alone
  }
  return foldDbCopies(volumes, dbs);
}

async function volumeCopyLag(ctx: OrgContext, now: number): Promise<BackupCopyLagView[]> {
  const schedules = (await backupSchedules(ctx, ctx.activeOrgId).findMany({ where: { paused: false, optedOutAt: null } })) as Sched[];
  const copying = schedules.filter((s) => s.secondaryTargetId && s.secondaryTargetId !== s.targetId);
  if (copying.length === 0) return [];
  const volumes = [...new Set(copying.map((s) => s.volume))];
  const targets = [...new Set(copying.flatMap((s) => [s.targetId, s.secondaryTargetId!]))];
  const rows = (await ctx.db.snapshot.findMany({
    where: { orgId: ctx.activeOrgId, volume: { in: volumes }, targetId: { in: targets }, startedAt: { gte: new Date(now - LOOKBACK_MS) } },
    orderBy: { startedAt: 'desc' },
    distinct: ['volume', 'targetId', 'status'],
    select: { volume: true, targetId: true, status: true, startedAt: true, sizeBytes: true, error: true },
  })) as SnapRow[];
  return copyLag(copying, rows);
}
