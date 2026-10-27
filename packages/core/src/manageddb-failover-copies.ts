import type { FailoverCandidate } from './manageddb-failover';

/**
 * Managed-Postgres failover acts on ONE COPY, never on a service.
 *
 * A standby service runs one copy per server (`replicas: N`,
 * `maxReplicasPerNode: 1`, a per-node data volume: manageddb-storage,
 * manageddb-placement), so one service name stands for N data directories.
 * Promoting "the service" execs `pg_promote()` in whichever task answers
 * first: it can judge one copy's replay position and promote another, and a
 * retried pass can promote a second copy, leaving two writers on separate
 * data. So the manageddb reconcile:
 *
 *  - probes every running copy on its own (in recovery? replay LSN? lag);
 *  - gives `decideFailover` one candidate per copy (`copy` = its swarm node);
 *  - stamps the chosen copy on its service BEFORE the exec
 *    ({@link DB_FAILOVER_PROMOTING_LABEL}); from then on it is the only copy
 *    any pass may promote, and a later pass resumes it rather than choose again;
 *  - never promotes while a copy already takes writes, unless it is the copy
 *    swarmy began promoting. Anything else is refused loudly: a person decides;
 *  - then reshapes that service to the one promoted copy, pinned to its server
 *    (worker `manageddb-reshape.ts`), so one name means one writer.
 *
 * Pure: no IO.
 */

/** On the standby service being promoted: the swarm node of the copy (`<node>`). */
export const DB_FAILOVER_PROMOTING_LABEL = 'swarmy.db.failover.promoting';

/** One running copy (task) of a standby service, as probed this tick. */
export interface StandbyCopy {
  service: string;
  /** Swarm node the copy and its data volume live on; null = not known. */
  node: string | null;
  /** The running container probed, and the only one a promotion may exec in. */
  containerId: string;
  /** Agent (hub node id) that container is reached through. */
  agent: string;
  /** `pg_is_in_recovery()`: true = standby, false = already writes, null = no answer. */
  inRecovery: boolean | null;
  replayLsn: string | null;
  lagSeconds: number | null;
}

/** A copy swarmy began promoting (read off {@link DB_FAILOVER_PROMOTING_LABEL}). */
export interface PromotingMark {
  service: string;
  node: string;
}

export type CopyPromotionPlan =
  /** Nobody writes and nothing is mid-promotion: decide over these copies. */
  | { kind: 'decide'; candidates: FailoverCandidate[] }
  /** Finish the promotion swarmy began: this copy, and no other. */
  | { kind: 'resume'; copy: StandbyCopy }
  /** The shape is wrong for any promotion: hold, raise it, a person decides. */
  | { kind: 'refuse'; reason: string; target?: string };

const where = (c: { service: string; node: string | null }) => `${c.service} on ${c.node ?? 'an unknown server'}`;

/** The promoting mark on any member's labels, or null. */
export function promotingMark(members: ReadonlyArray<{ name: string; labels: Record<string, string> }>): PromotingMark | null {
  for (const m of members) {
    const node = m.labels[DB_FAILOVER_PROMOTING_LABEL]?.trim();
    if (node) return { service: m.name, node };
  }
  return null;
}

/** Does promoting `copy` of `service` need the service reshaped to that copy? */
export function needsReshape(service: { desiredReplicas?: number; runningReplicas?: number }): boolean {
  return (service.desiredReplicas ?? 1) > 1 || (service.runningReplicas ?? 0) > 1;
}

/** What a promotion pass may do with these copies. Deterministic. */
export function planCopyPromotion(i: { copies: readonly StandbyCopy[]; promoting: PromotingMark | null }): CopyPromotionPlan {
  const writers = i.copies.filter((c) => c.inRecovery === false);
  if (writers.length > 1) {
    return {
      kind: 'refuse',
      reason: `${writers.length} standby copies already take writes (${writers.map(where).join(', ')}), so promoting would not leave one writer`,
    };
  }
  const p = i.promoting;
  if (p) {
    const mine = i.copies.find((c) => c.service === p.service && c.node === p.node);
    const other = writers[0];
    if (other && other !== mine) {
      return { kind: 'refuse', target: p.service, reason: `${where(other)} takes writes, but swarmy was promoting ${where(p)}` };
    }
    if (!mine) {
      return {
        kind: 'refuse',
        target: p.service,
        reason: `swarmy began promoting ${where(p)} and can't reach that copy now; promoting another copy could leave two writers`,
      };
    }
    return { kind: 'resume', copy: mine };
  }
  const other = writers[0];
  if (other) {
    return { kind: 'refuse', target: other.service, reason: `${where(other)} already takes writes, and swarmy didn't promote it` };
  }
  const candidates = i.copies
    .filter((c): c is StandbyCopy & { node: string } => c.node !== null)
    .map((c) => ({ service: c.service, copy: c.node, running: 1, replayLsn: c.inRecovery ? c.replayLsn : null, lagSeconds: c.lagSeconds }));
  const unnamed = i.copies.find((c) => c.node === null);
  if (candidates.length === 0 && unnamed) {
    return { kind: 'refuse', target: unnamed.service, reason: `swarmy can't tell which server ${unnamed.service}'s copy runs on, so it can't promote that copy alone` };
  }
  return { kind: 'decide', candidates };
}

/** One copy's probe: `<in recovery>|<replay lag seconds>|<replay LSN or empty>`. */
export const COPY_PROBE_SQL =
  "SELECT pg_is_in_recovery()::text || '|' || COALESCE(EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())),0)::text || '|' || COALESCE(pg_last_wal_replay_lsn()::text,'')";

/** Parse {@link COPY_PROBE_SQL}'s output; null when it isn't one. */
export function parseCopyProbe(raw: string): Pick<StandbyCopy, 'inRecovery' | 'replayLsn' | 'lagSeconds'> | null {
  const line = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l.split('|').length === 3);
  if (!line) return null;
  const [rec, secs, lsn] = line.split('|') as [string, string, string];
  const inRecovery = rec === 'true' || rec === 't' ? true : rec === 'false' || rec === 'f' ? false : null;
  const n = Number.parseFloat(secs);
  if (inRecovery === null || !Number.isFinite(n)) return null;
  return { inRecovery, lagSeconds: Math.max(0, Math.round(n * 10) / 10), replayLsn: lsn || null };
}

/**
 * A plain service scale of a managed Postgres WRITER past one copy: refused
 * (one name, one writer). Its standby copies are scaled from its Data page.
 */
export function writerScaleRefusal(labels: Record<string, string>, replicas: number): string | null {
  if (replicas <= 1 || labels['swarmy.db.engine'] !== 'postgres' || labels['swarmy.db.role'] !== 'primary') return null;
  return 'A managed Postgres writer runs as one copy. Add standby copies from its page under Data.';
}

/** The probed copy a decision names (service + copy), or undefined. */
export function chosenCopy(copies: readonly StandbyCopy[], d: { target: string; copy?: string }): StandbyCopy | undefined {
  return copies.find((c) => c.service === d.target && c.node !== null && c.node === d.copy);
}
