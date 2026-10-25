import type { NodeVolumeSizes } from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * Demo `nodes.volumeSizes` (boards 9 + 36): each server's local volumes as
 * its agent measured them (`/system/df?type=volume`, every 10 min). A
 * service's named volume sits on the server it runs on, so a finished demo
 * move carries its size along. wkr-2's agent is two releases behind and
 * predates the report, so its volumes read "size not reported". Prometheus
 * is big on purpose: it won't fit on wkr-1 (81% full) with room to spare.
 */

const GiB = 1024 ** 3;

/** Bytes per volume name; anything else a service mounts is a small 120 MB. */
const SIZES: Record<string, number> = {
  data_pgdata: 4.2 * GiB,
  data_redis: 0.6 * GiB,
  platform_grafana: 0.3 * GiB,
  platform_prometheus: 38 * GiB,
};

/** Agents that predate volume sizes (wkr-2 is the server two versions behind). */
const OLD_AGENTS = new Set(['n-wkr-2']);

/** When the demo agents last measured: a few minutes ago, like a 10-minute cadence. */
const MEASURED_AGO_MS = 4 * 60_000;

export function demoVolumeSizes(store: DemoStore): NodeVolumeSizes[] {
  const sampledAt = Date.now() - MEASURED_AGO_MS;
  return store.nodes.map((n) => {
    if (OLD_AGENTS.has(n.id) || n.status === 'offline') return { nodeId: n.id, sampledAt: null, volumes: [] };
    const volumes = store.services
      .filter((sv) => sv.nodeId === n.id)
      .flatMap((sv) => sv.volumes.filter((v) => v.type === 'volume' && v.source).map((v) => v.source!))
      .map((name) => ({ name, sizeBytes: Math.round(SIZES[name] ?? 0.12 * GiB) }))
      .sort((a, b) => b.sizeBytes - a.sizeBytes);
    return { nodeId: n.id, sampledAt, volumes };
  });
}

export const volumeSizesDemo: DomainResolvers = {
  handlers: {
    'nodes.volumeSizes': (_i, store) => demoVolumeSizes(store),
  },
};
