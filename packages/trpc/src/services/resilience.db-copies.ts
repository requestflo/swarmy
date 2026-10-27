/**
 * Resilience check `db-one-place`: a production database whose backups live
 * in one place. Its schedule names no second destination, or the copy there
 * has never landed: lose that one destination (or just reach it), and nothing
 * else can restore the database. PURE classifier over a signal read off the
 * primaries' labels (`swarmy.db.backup.schedule` / `.copy`) and the
 * destinations (backups-dr invariant 9: never read ctx from a classifier).
 *
 * The same signal tells the `storage-offsite` check which database schedules
 * keep a copy outside the cluster.
 */
import { buildInventory, type ResilienceProblemView } from '@swarmy/core';
import type { DbBackupEngine } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { backupTargets } from './backups.repo';
import { resticNetworkFor } from './backups.service';
import { DB_BACKUP_LAST_RUN_LABEL, DB_BACKUP_SCHEDULE_LABEL, clusterPrimaries, parseLastRunLabel, parseScheduleLabel } from './dbBackup.service';
import { copyFields } from './dbBackupCopy.read';
import { DB_CLUSTER_LABEL } from './manageddb.service';

export interface DbCopySignal {
  clusters: Array<{
    stack: string;
    cluster: string;
    production: boolean;
    engine: DbBackupEngine;
    /** Where every save goes first, and whether that is inside this swarm (swarmy's own store, a server's disk). */
    targetName: string | null;
    inCluster: boolean;
    /** The second copy: none, set but not made yet, never landed (its last try failed), or landed. */
    copy: 'none' | 'pending' | 'never-landed' | 'landed';
    lastError: string | null;
    /** A copy of these saves is outside the cluster (the main destination, or a landed second one). */
    offsite: boolean;
  }>;
}

export function dbOnePlaceProblems(sig: DbCopySignal | undefined): ResilienceProblemView[] {
  const out: ResilienceProblemView[] = [];
  for (const c of sig?.clusters ?? []) {
    if (!c.production || c.copy === 'landed') continue;
    const ref = `${c.stack}/${c.cluster}`;
    const where = c.targetName ? ` (${c.targetName})` : '';
    const failing = c.copy === 'never-landed';
    const pending = c.copy === 'pending';
    const detail = failing
      ? `Every save goes to one destination${where}, and the copy to the second has never landed${c.lastError ? `: ${c.lastError.slice(0, 200)}` : '.'}`
      : pending
        ? `Its second destination gets the first copy at the next save; until then every save lives in one place${where}.`
        : c.inCluster
        ? `Every save stays inside this cluster${where}: losing the cluster loses the database and its backups together.`
        : `Every save goes to one destination${where}: if it is lost or can't be reached, nothing else can restore ${ref}.`;
    out.push({
      id: `db-one-place/${ref}`,
      check: 'db-one-place',
      severity: pending ? 'info' : 'warn',
      title: `Production database ${ref} has its backups in one place`,
      detail,
      fixHint:
        c.engine === 'pgbackrest'
          ? 'pgBackRest writes one bucket and swarmy can’t copy it: back it up with wal-g or pg_dump, then add a second copy.'
          : failing
            ? 'Check the second destination’s credentials and that it can be reached; the next save copies again.'
            : pending
              ? 'Back it up now: the save is copied to the second destination right after.'
              : 'Pick a second destination, ideally off-site, under “Also copy to” on its backups.',
      fixPath: `/stacks/${c.stack}/backups`,
      fixLabel: failing ? 'See why the copy fails' : pending ? 'Back it up now' : 'Add a second copy',
      resource: ref,
    });
  }
  return out;
}

/** Every scheduled managed Postgres in scope, with where its saves live. */
export async function dbCopySignal(ctx: OrgContext, stack?: string): Promise<DbCopySignal> {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  const inv = buildInventory(services, containers).services;
  const targets = (await backupTargets(ctx, ctx.activeOrgId).findMany({ where: { orgId: ctx.activeOrgId } })) as Array<{
    id: string; name: string; kind: string; endpoint: string | null; enabled: boolean; createdAt: Date | string;
  }>;
  const byId = new Map(targets.map((t) => [t.id, t]));
  const first = targets.filter((t) => t.enabled).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
  const inside = (t: { kind: string; endpoint: string | null } | undefined): boolean => !t || t.kind.toUpperCase() === 'NODE' || Boolean(resticNetworkFor(t.endpoint));
  const now = Date.now();
  const clusters: DbCopySignal['clusters'] = [];
  for (const p of clusterPrimaries(ctx)) {
    if (stack && p.stack !== stack) continue;
    const schedule = parseScheduleLabel(p.labels[DB_BACKUP_SCHEDULE_LABEL]);
    if (!schedule) continue;
    const ref = `${p.stack}/${p.labels[DB_CLUSTER_LABEL] ?? ''}`;
    const main = schedule.targetId ? byId.get(schedule.targetId) : first;
    const lastRun = parseLastRunLabel(p.labels[DB_BACKUP_LAST_RUN_LABEL]);
    const { copy } = copyFields({ orgId: ctx.activeOrgId, ref, labels: p.labels, schedule: { ...schedule, targetId: main?.id }, lastRun, targetName: () => null, now });
    const landed = copy?.newestCopyAt != null;
    clusters.push({
      stack: p.stack,
      cluster: p.labels[DB_CLUSTER_LABEL] ?? '',
      production: inv.some((s) => s.stack === p.stack && s.labels['swarmy.env'] === 'production'),
      engine: schedule.engine,
      targetName: main?.name ?? null,
      inCluster: inside(main),
      copy: !copy ? 'none' : landed ? 'landed' : copy.failing ? 'never-landed' : 'pending',
      lastError: copy?.lastError ?? null,
      offsite: !inside(main) || (landed && !inside(byId.get(copy.targetId))),
    });
  }
  return { clusters };
}
