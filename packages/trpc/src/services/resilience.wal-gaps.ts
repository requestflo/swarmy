/**
 * Resilience check `wal-gap`: a wal-g PITR cluster's WAL archive has a
 * stretch missing for good, so a point-in-time restore cannot land inside it.
 * An open gap (no base backup taken since) leaves every later time out of
 * reach until one is; a gap a newer base backup has bridged only loses the
 * times inside it. PURE classifier; the signal is the last WAL check per
 * cluster from process memory, refreshed in the background (backups-dr
 * invariant 9: never read ctx from a classifier).
 */
import { buildInventory, type DbWalCheckView, type ResilienceProblemView } from '@swarmy/core';
import type { OrgContext } from '../context';
import { DB_BACKUP_SCHEDULE_LABEL, parseScheduleLabel } from './dbBackup.service';
import { knownWalCheck } from './dbWalCheck.cache';
import { gapWords, walCheckView } from './dbWalCheck.judge';
import { refreshWalChecks } from './dbWalCheck.service';
import { DB_CLUSTER_LABEL, DB_MEMBER_LABEL, DB_ROLE_LABEL } from './manageddb.service';

export interface WalGapSignal {
  clusters: Array<{ stack: string; cluster: string; production: boolean; check: DbWalCheckView }>;
}

export function walGapProblems(sig: WalGapSignal | undefined): ResilienceProblemView[] {
  const out: ResilienceProblemView[] = [];
  for (const c of sig?.clusters ?? []) {
    const ref = `${c.stack}/${c.cluster}`;
    const fix = { fixPath: `/stacks/${c.stack}/backups`, resource: ref } as const;
    c.check.gaps.forEach((g, i) => {
      const open = g.reachableAgainAt == null;
      out.push({
        id: `wal-gap/${ref}/${i}`,
        check: 'wal-gap',
        severity: open ? (c.production ? 'crit' : 'warn') : 'info',
        title: open ? `${ref} can't be restored to any time after a WAL gap` : `${ref} has a WAL gap a restore can't land inside`,
        detail: `${g.segments} WAL segment${g.segments === 1 ? ' is' : 's are'} missing from the archive, ${gapWords(g)}. ${
          open ? 'Replay stops at the gap, and no base backup has been taken since.' : 'A base backup taken after it lets later times restore again.'
        }`,
        fixHint: open ? 'Take a base backup now: restores after it start from it, past the gap.' : 'Nothing to fix for later times; times inside the gap are lost.',
        fixLabel: open ? 'Back it up now' : 'See its backups',
        ...fix,
      });
    });
    if (c.check.timeline === 'failure') {
      out.push({
        id: `wal-gap/${ref}/timeline`,
        check: 'wal-gap',
        severity: 'warn',
        title: `${ref}'s WAL archive has a newer timeline than the database`,
        detail: 'Another server wrote to the same archive after a split or a restore, so restores may replay the wrong history.',
        fixHint: 'Point the cluster at a fresh backup prefix, or take a base backup and check which server writes the archive.',
        fixLabel: 'See its backups',
        ...fix,
      });
    }
  }
  return out;
}

/** The wal-g PITR clusters in scope with their last WAL check; starts a refresh of stale ones. */
export function walGapSignal(ctx: OrgContext, stack?: string): WalGapSignal | undefined {
  try {
    const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
    const inv = buildInventory(services, containers).services.filter((s) => !stack || s.stack === stack);
    const pitr = inv.filter((s) => {
      if (!s.labels[DB_CLUSTER_LABEL] || s.labels[DB_ROLE_LABEL] !== 'primary' || s.labels[DB_MEMBER_LABEL]) return false;
      const sched = parseScheduleLabel(s.labels[DB_BACKUP_SCHEDULE_LABEL]);
      return sched?.pitr === true && sched.engine === 'wal-g';
    });
    const refs = pitr.map((s) => ({ stack: s.stack, cluster: s.labels[DB_CLUSTER_LABEL]! }));
    refreshWalChecks(ctx, refs);
    const clusters = refs.flatMap((r) => {
      const read = knownWalCheck(ctx.activeOrgId, `${r.stack}/${r.cluster}`);
      if (!read) return [];
      const production = inv.some((s) => s.stack === r.stack && s.labels['swarmy.env'] === 'production');
      return [{ ...r, production, check: walCheckView({ status: 'read', result: read }) }];
    });
    return { clusters };
  } catch {
    return undefined;
  }
}
