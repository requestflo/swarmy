import type { ContainerStatsSnapshot, ServiceUsageView } from '@swarmy/core';
import type { OrgContext } from '../context';
import { notFound } from '../errors';
import { liveService } from './service.service';

/**
 * Per-copy usage from samples already matched to the service's copies. PURE.
 * CPU: Docker's percent is of one core, so 100% → 1 core.
 */
export function summarizeUsage(samples: readonly ContainerStatsSnapshot[], ts: number): ServiceUsageView | null {
  if (samples.length === 0) return null;
  const cores = samples.map((s) => Math.max(0, s.cpuPercent) / 100);
  const mem = samples.map((s) => s.memUsedBytes);
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    sampled: samples.length,
    cpuCores: { avg: avg(cores), peak: Math.max(...cores) },
    memBytes: { avg: Math.round(avg(mem)), peak: Math.max(...mem) },
    ts,
  };
}

/**
 * The live usage of one service's copies: join the service's containers (live
 * inventory, Docker truth) with each online server's latest container stats.
 */
export function serviceUsage(ctx: OrgContext, id: string): ServiceUsageView | null {
  const svc = liveService(ctx, id);
  if (!svc) throw notFound('service', id);
  const ids = new Set(svc.containers.map((c) => c.id));
  const short = new Set(svc.containers.map((c) => c.id.slice(0, 12)));
  const samples: ContainerStatsSnapshot[] = [];
  for (const nodeId of ctx.hub.onlineNodeIds()) {
    for (const s of ctx.hub.latestContainerStats(nodeId)) {
      if (ids.has(s.containerId) || short.has(s.containerId.slice(0, 12))) samples.push(s);
    }
  }
  return summarizeUsage(samples, Date.now());
}
