import { z } from 'zod';
import { Timestamp } from './primitives';

/** Aggregate node-level resource sample. */
export const NodeMetricsSample = z.object({
  cpuPercent: z.number(), // 0..(100 * cpuCount)
  memUsedBytes: z.number().int().nonnegative(),
  memTotalBytes: z.number().int().nonnegative(),
  loadAvg1: z.number().optional(),
  netRxBytes: z.number().int().nonnegative().optional(),
  netTxBytes: z.number().int().nonnegative().optional(),
  fsUsedBytes: z.number().int().nonnegative().optional(),
  fsTotalBytes: z.number().int().nonnegative().optional(),
});
export type NodeMetricsSample = z.infer<typeof NodeMetricsSample>;

/** Per-container resource sample. */
export const ContainerMetricsSample = z.object({
  containerId: z.string(),
  name: z.string(),
  cpuPercent: z.number(),
  memUsedBytes: z.number().int().nonnegative(),
  memLimitBytes: z.number().int().nonnegative(),
  netRxBytes: z.number().int().nonnegative(),
  netTxBytes: z.number().int().nonnegative(),
  blkReadBytes: z.number().int().nonnegative().optional(),
  blkWriteBytes: z.number().int().nonnegative().optional(),
  pids: z.number().int().nonnegative().optional(),
});
export type ContainerMetricsSample = z.infer<typeof ContainerMetricsSample>;

/** Requests one edge Caddy served for one host since the previous scrape. */
export const EdgeHostTraffic = z.object({
  /** Request Host as Caddy's `per_host` metrics label it (lower-case, no port). */
  host: z.string().min(1),
  /** Requests since the previous scrape (a counter DELTA, never a total). */
  requests: z.number().int().nonnegative(),
  /** Of those, responses with a 5xx status. */
  errors5xx: z.number().int().nonnegative(),
});
export type EdgeHostTraffic = z.infer<typeof EdgeHostTraffic>;

/**
 * Per-edge request counts (Q4): the agent on a node running the swarmy edge
 * Caddy scrapes Caddy's local Prometheus `/metrics` and reports per-host
 * deltas since its previous scrape. Absent on non-edge nodes, on the first
 * scrape (no baseline yet) and from agents that predate it.
 */
export const EdgeTrafficSample = z.object({
  sampledAt: Timestamp,
  /** Seconds covered by these deltas (time since the previous scrape). */
  intervalSec: z.number().positive(),
  hosts: z.array(EdgeHostTraffic),
});
export type EdgeTrafficSample = z.infer<typeof EdgeTrafficSample>;

export const MetricsPayload = z.object({
  sampledAt: Timestamp,
  node: NodeMetricsSample,
  containers: z.array(ContainerMetricsSample),
  /** Edge request counts — OPTIONAL so older agents/controllers interoperate. */
  edge: EdgeTrafficSample.optional(),
});
export type MetricsPayload = z.infer<typeof MetricsPayload>;

export const MetricsMsg = z.object({
  type: z.literal('metrics'),
  payload: MetricsPayload,
});
export type MetricsMsg = z.infer<typeof MetricsMsg>;

export const HeartbeatPayload = z.object({
  seq: z.number().int().nonnegative(),
  uptimeSec: z.number().int().nonnegative(),
  inflightCommands: z.number().int().nonnegative(),
  /** Re-detected public IP (hourly) so label drift heals without re-register. */
  publicIp: z.string().optional(),
  /**
   * Whether that public IP reaches this server (`public`) or it sits behind
   * NAT (`nat` — a home VM). Absent = the agent can't tell. Stamped as the
   * `swarmy.node.reachability` label; NAT'd servers never get manager/Garage/
   * edge roles in a retire plan (QA-084).
   */
  reachability: z.enum(['public', 'nat']).optional(),
});
export type HeartbeatPayload = z.infer<typeof HeartbeatPayload>;

export const HeartbeatMsg = z.object({
  type: z.literal('heartbeat'),
  payload: HeartbeatPayload,
});
export type HeartbeatMsg = z.infer<typeof HeartbeatMsg>;
