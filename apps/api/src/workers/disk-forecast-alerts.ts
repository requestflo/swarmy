/**
 * Disk-full FORECAST conditions for the alert evaluator
 * (plans/epic-volume-mobility.md, phase 5).
 *
 * Rides the existing `disk-usage` rule (one "Disk almost full" rule; turning
 * it off silences both the level alert and the forecast), under its own
 * resource key `node:<name>:forecast`, so a node can have "85% full now" and
 * "full in 9 days" open at once without the two colliding.
 *
 * Each condition carries a CONCRETE next step computed from live truth:
 * the data services pinned to the node, and the server with the most room
 * (the decommission planner's DestinationPicker rules).
 *
 * The pure half (`forecastConditions`) is unit-tested; `loadDiskSeries` is the
 * telemetry.db read, cached per node so a 30 s evaluator tick does not re-read
 * a week of samples every time.
 */
import { telemetry } from '@swarmy/db';
import {
  PINNED_DATA_LABELS,
  describeDiskForecast,
  diskForecastSeverity,
  forecastDiskFull,
  type DiskForecast,
  type DiskSample,
} from '@swarmy/core';
import type { Condition } from './alert-evaluator';

/** Re-read a node's series at most this often. */
export const FORECAST_CACHE_MS = 15 * 60_000;
const WINDOW_MS = 7 * 86_400_000;
/** Enough points for a fit; the sampler writes one a minute. */
const MAX_ROWS = 4000;

export interface ForecastNode {
  name: string;
  /** Swarm node id (pin labels carry it); undefined = not reported. */
  swarmNodeId?: string;
  series: DiskSample[];
  /** Latest live sample (fresher than the series). */
  live?: { usedBytes: number; totalBytes: number } | null;
  schedulable: boolean;
}

function formatBytes(b: number): string {
  const gb = b / 1024 ** 3;
  return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

/** The "what to do" half of the message. Pure. */
export function forecastSuggestion(
  node: ForecastNode,
  nodes: readonly ForecastNode[],
  services: ReadonlyArray<{ name: string; labels: Record<string, string> }>,
): string {
  const pinned = node.swarmNodeId
    ? services.filter((s) => PINNED_DATA_LABELS.some((k) => s.labels[k] === node.swarmNodeId)).map((s) => s.name).sort()
    : [];
  const roomOf = (n: ForecastNode) => {
    const d = n.live ?? n.series[n.series.length - 1];
    return d && d.totalBytes > 0 ? d.totalBytes * 0.85 - d.usedBytes : -1;
  };
  const best = nodes
    .filter((n) => n.name !== node.name && n.schedulable && roomOf(n) > 0)
    .sort((a, b) => roomOf(b) - roomOf(a))[0];
  const parts = [`add a disk to ${node.name} (attach a volume at your provider; swarmy offers to use it)`];
  if (pinned.length > 0 && best) {
    parts.push(`move ${pinned[0]}${pinned.length > 1 ? ` (or ${pinned.length - 1} other data service${pinned.length > 2 ? 's' : ''})` : ''} to ${best.name}, which has ${formatBytes(roomOf(best))} free`);
  } else if (best) {
    parts.push(`retire ${node.name} and let swarmy move its apps to ${best.name}`);
  }
  return `Next step: ${parts.join(', or ')}.`;
}

/** Forecast conditions for every node. Pure. */
export function forecastConditions(
  nodes: readonly ForecastNode[],
  services: ReadonlyArray<{ name: string; labels: Record<string, string> }>,
  now: number,
): Condition[] {
  const out: Condition[] = [];
  for (const n of nodes) {
    const series = n.live ? [...n.series, { ts: now, ...n.live }] : n.series;
    const f: DiskForecast = forecastDiskFull(series, { now });
    const severity = diskForecastSeverity(f);
    if (!severity) continue;
    out.push({
      signal: 'disk-usage',
      resource: `node:${n.name}:forecast`,
      severity,
      message: `Disk on ${n.name}: ${describeDiskForecast(f)} ${forecastSuggestion(n, nodes, services)}`,
    });
  }
  return out;
}

const cache = new Map<string, { at: number; series: DiskSample[] }>();

/** A node's last-week disk series from telemetry.db (cached). */
export async function loadDiskSeries(orgId: string, nodeId: string, now: number): Promise<DiskSample[]> {
  const hit = cache.get(nodeId);
  if (hit && now - hit.at < FORECAST_CACHE_MS) return hit.series;
  let series: DiskSample[] = [];
  try {
    const rows = (await telemetry.metricSample.findMany({
      where: { orgId, nodeId, scope: 'NODE', ts: { gte: new Date(now - WINDOW_MS) } },
      orderBy: { ts: 'desc' },
      take: MAX_ROWS,
      select: { ts: true, diskUsedBytes: true, diskTotalBytes: true },
    })) as Array<{ ts: Date; diskUsedBytes: bigint | number; diskTotalBytes: bigint | number }>;
    series = rows
      .map((r) => ({ ts: r.ts.getTime(), usedBytes: Number(r.diskUsedBytes), totalBytes: Number(r.diskTotalBytes) }))
      .filter((s) => s.totalBytes > 0)
      .reverse();
  } catch {
    // telemetry unavailable: no forecast this tick (the level alert still runs).
  }
  cache.set(nodeId, { at: now, series });
  return series;
}
