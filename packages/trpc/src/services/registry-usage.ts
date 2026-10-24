/**
 * The registry's measured size + image counts, per org, held in controller
 * memory. Measured as a by-product of the registry GC pass (the read-only scan
 * one-shot `du`s the volume on the node that holds it, every image-gc tick),
 * so reading it costs nothing. Counters and timestamps never go to raft
 * (docker-native-storage rule); after a controller restart the page says "not
 * measured yet" until the next tick.
 */
import type { RegistryStats } from './registry-gc.scripts';

export interface RegistryUsageView extends RegistryStats {
  measuredAt: string;
  /** The last pass that deleted something (null = none since the controller started). */
  lastGc: { at: string; deleted: number; reclaimedBytes: number | null } | null;
}

const usage = new Map<string, RegistryUsageView>();

export function recordRegistryUsage(
  orgId: string,
  stats: RegistryStats,
  at: Date,
  gc?: { deleted: number; reclaimedBytes: number | null },
): void {
  const prev = usage.get(orgId);
  usage.set(orgId, {
    ...stats,
    measuredAt: at.toISOString(),
    lastGc: gc ? { at: at.toISOString(), ...gc } : (prev?.lastGc ?? null),
  });
}

export function getRegistryUsage(orgId: string): RegistryUsageView | null {
  return usage.get(orgId) ?? null;
}
