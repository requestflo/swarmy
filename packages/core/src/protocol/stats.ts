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

export const MetricsPayload = z.object({
  sampledAt: Timestamp,
  node: NodeMetricsSample,
  containers: z.array(ContainerMetricsSample),
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
});
export type HeartbeatPayload = z.infer<typeof HeartbeatPayload>;

export const HeartbeatMsg = z.object({
  type: z.literal('heartbeat'),
  payload: HeartbeatPayload,
});
export type HeartbeatMsg = z.infer<typeof HeartbeatMsg>;
