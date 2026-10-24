import { FAILOVER_WATERMARK_MAX_GAP_MS, type PrimaryWatermark } from '@swarmy/core';

/**
 * The failover LSN watermark, persisted across controller restarts — PURE.
 *
 * The manageddb-reconcile worker samples each primary's last flushed LSN on
 * every healthy tick (the caught-up proof `decideFailover` needs). Those
 * samples used to live only in memory, so a controller restart during an
 * outage left the watermark unknown and every failover held for a human.
 *
 * Where it lives: it is RUN STATE (a probe result + its timestamp, rewritten
 * every tick), so per docker-native-storage it goes in the controller store's
 * `OperationRun` row (`kind = db.failoverWatermark`, one JSON map per org) —
 * never a label or swarm-kv document (no timestamps or run state in raft, and
 * a label rewrite every 15 s would churn the primary's service spec).
 *
 * The safety rule is unchanged: a sample proves nothing about writes the
 * primary took after it. In memory, the decision accepts a sample taken at
 * most FAILOVER_WATERMARK_MAX_GAP_MS before the last healthy tick, and the
 * primary is next seen unhealthy one tick later — so the unobserved window is
 * at most gap + one tick. A RESTORED sample gets exactly that envelope,
 * measured from the sample to this process's FIRST unhealthy observation
 * ({@link RESTORED_WATERMARK_MAX_AGE_MS}). A longer controller outage, a
 * different primary, or nothing stored ⇒ null ⇒ unknown ⇒ hold.
 */

/** `OperationRun.kind` holding one org's watermark map. */
export const WATERMARK_RUN_KIND = 'db.failoverWatermark';
/** The worker's healthy-tick cadence (mirrors manageddb-reconcile TICK_MS). */
export const WATERMARK_TICK_MS = 15_000;
/** Max age of a restored sample at the first unhealthy observation (= the in-memory envelope). */
export const RESTORED_WATERMARK_MAX_AGE_MS = FAILOVER_WATERMARK_MAX_GAP_MS + WATERMARK_TICK_MS;
/** Entries older than this can never be restored — pruned on the next write. */
const PRUNE_AFTER_MS = 10 * 60_000;

/** One cluster's last flushed-LSN sample, as stored. */
export interface PersistedWatermark {
  /** The primary service the sample was taken on (a promotion invalidates it). */
  primary: string;
  lsn: string;
  /** epoch ms of the sample. */
  sampledAt: number;
}

/** `<stack>/<cluster>` → sample. */
export type PersistedWatermarks = Record<string, PersistedWatermark>;

const LSN_RE = /^[0-9A-Fa-f]+\/[0-9A-Fa-f]+$/;

/** Defensive parse of the stored JSON (anything malformed is dropped, never trusted). */
export function parsePersistedWatermarks(raw: unknown): PersistedWatermarks {
  const out: PersistedWatermarks = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [cluster, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const e = v as Partial<PersistedWatermark>;
    if (typeof e.primary !== 'string' || !e.primary) continue;
    if (typeof e.lsn !== 'string' || !LSN_RE.test(e.lsn)) continue;
    if (typeof e.sampledAt !== 'number' || !Number.isFinite(e.sampledAt)) continue;
    out[cluster] = { primary: e.primary, lsn: e.lsn, sampledAt: e.sampledAt };
  }
  return out;
}

/**
 * The decideFailover inputs a stored sample may stand in for, or null (hold).
 * Only for a process that has NOT seen this primary healthy itself.
 */
export function restoreWatermark(
  entry: PersistedWatermark | undefined,
  input: { primary: string | undefined; firstUnhealthyAt: number },
  maxAgeMs: number = RESTORED_WATERMARK_MAX_AGE_MS,
): { watermark: PrimaryWatermark; lastHealthyAt: number } | null {
  if (!entry || !input.primary || entry.primary !== input.primary) return null;
  const age = input.firstUnhealthyAt - entry.sampledAt;
  if (age < 0 || age > maxAgeMs) return null;
  return { watermark: { lsn: entry.lsn, sampledAt: entry.sampledAt }, lastHealthyAt: entry.sampledAt };
}

/** Store a fresh healthy-tick sample; prune entries too old to ever restore. */
export function recordWatermark(
  prev: PersistedWatermarks,
  cluster: string,
  sample: PersistedWatermark,
): PersistedWatermarks {
  const out: PersistedWatermarks = {};
  for (const [k, v] of Object.entries(prev)) {
    if (k !== cluster && sample.sampledAt - v.sampledAt <= PRUNE_AFTER_MS) out[k] = v;
  }
  out[cluster] = sample;
  return out;
}

/** Drop a cluster's sample (after a promotion the old writer's LSN proves nothing). */
export function forgetWatermark(prev: PersistedWatermarks, cluster: string): PersistedWatermarks {
  if (!(cluster in prev)) return prev;
  const out = { ...prev };
  delete out[cluster];
  return out;
}
