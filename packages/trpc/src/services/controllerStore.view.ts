/**
 * Controller store status as the dashboard shows it (resilience P3). PURE:
 * the controller process reports its runtime status
 * (apps/api/src/controller-store/supervisor.ts), and this turns it into the
 * view, including the one-line summary "controller store: local only" /
 * "controller store: replicated (lag Ns)".
 *
 * The lag is MEASURED in the controller (controller-store/lag.ts): the age of
 * the oldest local write the replica didn't hold at its last read.
 */
import type { ControllerLeaseRecord } from '@swarmy/core/protocol';

/** At or past this much lag, replication "needs a look". */
export const LAG_WARN_SECONDS = 30;
/** A replica read older than this proves nothing about the lag now. */
export const STALE_READ_MS = 60_000;

/** What the controller process reports (structurally = ControllerStoreStatus in apps/api). */
export interface ControllerStoreRuntimeStatus {
  role: 'standalone' | 'acquiring' | 'leader' | 'fenced' | 'stopping';
  identity: { taskId: string; nodeId: string; hostname: string; service: string };
  lease: ControllerLeaseRecord | null;
  epoch: number | null;
  leaseAgeMs: number | null;
  waitingFor: string | null;
  replica: null | {
    kind: 'garage' | 'backup-target';
    label: string;
    targetId?: string;
    endpoint: string;
    bucket: string;
    prefix: string;
    /** The replica's S3 key id (not a secret) — lets the platform-key GC know it's in use. */
    accessKeyId?: string;
  };
  replicating: boolean;
  replicationBlocked: string | null;
  litestream: null | {
    running: boolean;
    lastSyncAt: string | null;
    txid: string | null;
    replicaTxid: string | null;
    behindTxns: number | null;
    lagMs: number | null;
    replicaCheckedAgoMs: number | null;
    error: string | null;
    restarts: number;
  };
  bundleConfigured: boolean;
  boot: null | { at: string; decision: { kind: string; reason: string }; outcome: string; durationMs: number };
  dbPath: string;
}

export interface ControllerMoveTarget {
  swarmNodeId: string;
  hostname: string;
  status: string;
  availability: string;
  current: boolean;
  /** Why this manager can't take the controller right now (null = eligible). */
  blocked: string | null;
}

export interface ControllerStoreView {
  role: ControllerStoreRuntimeStatus['role'];
  hostname: string;
  swarmNodeId: string;
  epoch: number | null;
  leaseRenewedAgoSec: number | null;
  waitingFor: string | null;
  mode: 'replicated' | 'local-only';
  target: ControllerStoreRuntimeStatus['replica'];
  replicating: boolean;
  lastReplicatedAt: string | null;
  /** Seconds of writes not yet in the replica (0 = caught up; null = unknown). */
  lagSeconds: number | null;
  /** Transactions the replica didn't hold at its last read (null = unknown). */
  behindTxns: number | null;
  problem: string | null;
  /** "controller store: local only" / "controller store: replicated (lag 0s)". */
  summary: string;
  bundleFallback: boolean;
  boot: { at: string; kind: string; outcome: string; reason: string; durationMs: number } | null;
  /** Expected loss window if this node died now. */
  lossWindow: string;
  managers: ControllerMoveTarget[];
}

/** The lag the dashboard may claim: null unless replicating with a fresh replica read. */
function measuredLag(s: ControllerStoreRuntimeStatus): { lagSeconds: number | null; stale: boolean } {
  const ls = s.litestream;
  if (!s.replicating || !ls || ls.lagMs == null) return { lagSeconds: null, stale: false };
  // A failing read keeps the lag growing (lag.ts), so it stays meaningful.
  const stale = ls.replicaCheckedAgoMs == null || (ls.replicaCheckedAgoMs > STALE_READ_MS && !ls.error);
  return { lagSeconds: stale ? null : Math.round(ls.lagMs / 1000), stale };
}

/** Pure: the one line Backups and the resilience checks show. */
export function storeSummary(v: Pick<ControllerStoreView, 'role' | 'mode' | 'replicating' | 'lagSeconds'>): string {
  if (v.role === 'fenced') return 'controller store: fenced (this controller lost its lease and is stopping)';
  if (v.mode === 'local-only') return 'controller store: local only';
  if (!v.replicating) return 'controller store: replicated (not shipping yet)';
  return `controller store: replicated (lag ${v.lagSeconds == null ? 'unknown' : `${v.lagSeconds}s`})`;
}

/** Pure: turn the runtime status into what the dashboard shows. */
export function toStoreView(s: ControllerStoreRuntimeStatus, managers: ControllerMoveTarget[]): ControllerStoreView {
  const ls = s.litestream;
  const { lagSeconds, stale } = measuredLag(s);
  const problem =
    s.role === 'fenced'
      ? 'this controller lost its lease and is shutting down'
      : s.replica && !s.replicating
        ? (s.replicationBlocked ?? (s.role === 'acquiring' ? `waiting for the lease: ${s.waitingFor ?? 'starting'}` : 'replication not running'))
        : (ls?.error ??
          (stale
            ? `the replica hasn't been read for ${Math.round((ls?.replicaCheckedAgoMs ?? 0) / 1000)}s, so the lag is unknown`
            : lagSeconds != null && lagSeconds >= LAG_WARN_SECONDS
              ? `the replica is ${lagSeconds}s behind`
              : null));
  const base = {
    role: s.role,
    mode: s.replica ? ('replicated' as const) : ('local-only' as const),
    replicating: s.replicating,
    lagSeconds,
  };
  return {
    ...base,
    hostname: s.identity.hostname,
    swarmNodeId: s.identity.nodeId,
    epoch: s.epoch,
    leaseRenewedAgoSec: s.leaseAgeMs != null ? Math.round(s.leaseAgeMs / 1000) : null,
    waitingFor: s.waitingFor,
    target: s.replica,
    lastReplicatedAt: ls?.lastSyncAt ?? null,
    behindTxns: s.replicating ? (ls?.behindTxns ?? null) : null,
    problem,
    summary: storeSummary(base),
    bundleFallback: s.bundleConfigured,
    boot: s.boot
      ? { at: s.boot.at, kind: s.boot.decision.kind, outcome: s.boot.outcome, reason: s.boot.decision.reason, durationMs: s.boot.durationMs }
      : null,
    lossWindow: s.replica
      ? lagSeconds != null && lagSeconds > 1
        ? `about ${lagSeconds} seconds of writes (the replica is behind); none on a clean move`
        : 'about 1 second of writes (Litestream ships every second); none on a clean move'
      : 'everything since the last controller backup (the store is on this node only)',
    managers,
  };
}
