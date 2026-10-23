import { z } from 'zod';

/**
 * `nodes.statsHistory` — each server's last 24 hours of CPU, memory and disk
 * use, from telemetry.db's per-minute NODE samples (metrics-sampler), folded
 * into 5-minute PEAKS: each point is the busiest reading in its slot, so a
 * spike never averages away. The Servers inspector draws them as sparklines.
 */

export const NODE_STATS_HISTORY_HOURS = 24;
export const NODE_STATS_HISTORY_STEP_SECONDS = 300;
/** 288 five-minute slots. */
export const NODE_STATS_HISTORY_SLOTS = (NODE_STATS_HISTORY_HOURS * 3600) / NODE_STATS_HISTORY_STEP_SECONDS;

/** One server (by id), or every server of the org. */
export const NodeStatsHistoryInput = z.object({ nodeId: z.string().min(1).max(128).optional() });
export type NodeStatsHistoryInput = z.infer<typeof NodeStatsHistoryInput>;

/** % used per slot; null where no sample was kept — never a zero. */
export type NodeStatsSeries = Array<number | null>;

export interface NodeStatsHistoryServer {
  nodeId: string;
  name: string;
  /** CPU % (0–100) — the slot's peak. */
  cpu: NodeStatsSeries;
  /** Memory % used — the slot's peak. */
  mem: NodeStatsSeries;
  /** Disk % used — the slot's peak. */
  disk: NodeStatsSeries;
}

/**
 * One fixed grid for every server: point `i` covers the slot starting at
 * `from + i * stepSeconds`; the last slot holds "now" (still filling).
 * A server with no sample at all in the window is left out.
 */
export interface NodeStatsHistoryView {
  from: string;
  stepSeconds: number;
  /** How a slot folds its samples (always the peak). */
  fold: 'peak';
  servers: NodeStatsHistoryServer[];
}
