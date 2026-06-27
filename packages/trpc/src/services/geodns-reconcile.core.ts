/**
 * Health-aware Geo-DNS reconcile — pure core (epic #12, Part A — PHASE 2).
 *
 * The worker (apps/api/workers/geodns-reconcile.ts) polls live ingress/node
 * health per region and must (a) decide each DnsRecord's `healthy` bit, and
 * (b) decide whether the *healthy set* changed enough to re-render + redeploy
 * the CoreDNS zone. Both decisions are pure and unit-tested here; the worker is
 * a thin IO shell that mirrors this logic (it cannot subpath-import internal
 * trpc modules — same constraint as dr-reconcile).
 */

export interface ReconcileRecord {
  id: string;
  host: string;
  region: string;
  targetIngress: string;
  /** Currently persisted health bit. */
  healthy: boolean;
}

export interface RegionHealth {
  /** `swarmy.region` label value. */
  region: string;
  /** At least one node in this region is online (heartbeat). */
  nodeOnline: boolean;
  /**
   * Ingress in this region reports healthy. `undefined` = no ingress signal
   * available, in which case node-online alone decides health.
   */
  ingressHealthy?: boolean;
}

/** A record's computed health = node online AND (ingress healthy if known). */
export function computeRecordHealth(
  record: ReconcileRecord,
  health: Map<string, RegionHealth>,
): boolean {
  const h = health.get(record.region);
  if (!h) return false; // region has no live signal → unhealthy
  if (!h.nodeOnline) return false;
  if (h.ingressHealthy === false) return false;
  return true;
}

export interface ReconcilePlan {
  /** Records whose `healthy` bit must be flipped, with the new value. */
  updates: Array<{ id: string; healthy: boolean }>;
  /**
   * True when the *healthy set* (the set of record ids that are healthy)
   * changed — i.e. the zone answer set differs and CoreDNS must be re-rendered
   * and redeployed. A flip from healthy→unhealthy or unhealthy→healthy both
   * count; a no-op (already correct) does not.
   */
  healthySetChanged: boolean;
}

/**
 * Compute the minimal set of `healthy` flips plus whether the answer set
 * changed. Deterministic and side-effect free.
 */
export function planReconcile(
  records: ReconcileRecord[],
  health: Map<string, RegionHealth>,
): ReconcilePlan {
  const updates: Array<{ id: string; healthy: boolean }> = [];
  let healthySetChanged = false;
  for (const r of records) {
    const next = computeRecordHealth(r, health);
    if (next !== r.healthy) {
      updates.push({ id: r.id, healthy: next });
      healthySetChanged = true;
    }
  }
  return { updates, healthySetChanged };
}

/**
 * Stable signature of the healthy answer set for a zone: the sorted list of
 * `host|region|target` for every healthy record. The worker stores the previous
 * signature and only redeploys when it changes (debounce / idempotency).
 */
export function healthySignature(records: ReconcileRecord[]): string {
  return records
    .filter((r) => r.healthy)
    .map((r) => `${r.host}|${r.region}|${r.targetIngress}`)
    .sort()
    .join(',');
}
