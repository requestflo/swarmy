/**
 * Rows written since each database save (`dbBackups.writes`, board 10).
 *
 * Every logical save of a managed Postgres reads the primary's write
 * counters first (`DB_WRITES_SQL`, `@swarmy/core` db-writes.ts) and keeps
 * them on its `db.backup` audit row. This reads them live again, through the
 * studio's bounded path (the person's data.read gate, one `studio.query`
 * row under origin `writes`), and says per save how many rows changed since,
 * or that the counters started again (a restart, a switch-over, a stats
 * reset). A save taken before this existed, or whose read failed, has none.
 */
import { DB_WRITES_SQL, dbWritesFromMeta, dbWritesSince, parseDbWrites, type DbWriteCounters, type DbWritesView } from '@swarmy/core';
import type { OrgContext } from '../context';
import { resolveExecTarget } from './live-resolve';
import { studioSystemRead, studioViewRead } from './studio.service';

/** Audit rows read back: a week of nightly saves many times over. */
const SAVES_READ = 200;

/**
 * The counters just before a save, or null. Asked only when the primary has
 * a running task (else the read could only fail), as the system actor: one
 * `studio.query` row beside the save's own. Never fails the save.
 */
export async function readWritesBeforeSave(ctx: OrgContext, stack: string, cluster: string, primaryService: string): Promise<DbWriteCounters | null> {
  try {
    if (!resolveExecTarget(ctx, primaryService)) return null;
    const r = await studioSystemRead(ctx, { stack, target: cluster, statement: DB_WRITES_SQL, rowCap: 1 });
    return parseDbWrites(r.rows[0]);
  } catch {
    return null;
  }
}

const iso = (epochS: number): string => new Date(epochS * 1000).toISOString();

/** `dbBackups.writes`. */
export async function getDbWrites(ctx: OrgContext, input: { stack: string; cluster: string }): Promise<DbWritesView> {
  let live: DbWriteCounters | null = null;
  let database: string | null = null;
  try {
    const r = await studioViewRead(ctx, { stack: input.stack, target: input.cluster, statement: DB_WRITES_SQL, origin: 'writes', rowCap: 1 });
    live = parseDbWrites(r.rows[0]);
    database = r.database ?? null;
  } catch {
    live = null;
  }
  if (!live) return { read: false, database, countingSince: null, saves: [] };
  const rows = await ctx.db.auditLog.findMany({
    where: { orgId: ctx.activeOrgId, action: 'db.backup', targetType: 'dbCluster', targetId: `${input.stack}/${input.cluster}` },
    orderBy: { ts: 'desc' },
    take: SAVES_READ,
    select: { metadata: true },
  });
  const saves: DbWritesView['saves'] = [];
  for (const row of rows) {
    const meta = row.metadata as { snapshotId?: unknown } | null;
    const then = dbWritesFromMeta(meta);
    if (!then || typeof meta?.snapshotId !== 'string') continue;
    // `dbBackups.list` shows restic's short id: the first 8 of the full one a backup reports.
    saves.push({ snapshotId: meta.snapshotId.slice(0, 8), since: dbWritesSince(then, live) });
  }
  return { read: true, database, countingSince: iso(Math.max(live.serverStart, live.statsReset)), saves };
}
