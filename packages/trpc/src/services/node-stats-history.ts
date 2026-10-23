import {
  NODE_STATS_HISTORY_SLOTS,
  NODE_STATS_HISTORY_STEP_SECONDS,
  type NodeStatsHistoryInput,
  type NodeStatsHistoryServer,
  type NodeStatsHistoryView,
} from '@swarmy/core';
import { telemetryOf, type OrgContext } from '../context';
import { diskGridFrom } from './alerts-disk-history';

/**
 * `nodes.statsHistory` — each server's last 24 hours of CPU, memory and disk
 * (% used) for the Servers inspector's sparklines. Read-only, org-scoped: the
 * server list is the org's own enrolment rows, the samples are filtered on
 * `orgId`, and a sample for any other node is dropped. telemetry.db keeps one
 * NODE row per server per minute (metrics-sampler); the SQL folds them into
 * 5-minute PEAKS (the busiest reading in each slot), so ~1,440 rows a server
 * ship as 288 points and a spike never averages away.
 */

/** One SQL row: a node's peaks in one slot (epoch seconds ÷ step). Null = no usable reading. */
export interface NodeStatsSlotRow {
  nodeId: string;
  slot: number | bigint;
  cpu: number | null;
  mem: number | null;
  disk: number | null;
}

const pct = (v: unknown): number | null => {
  const n = v === null || v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? Math.round(Math.max(0, Math.min(100, n)) * 10) / 10 : null;
};

/**
 * Slot rows → one fixed grid per server, by name. Pure. Only `nodes` (the
 * org's own) appear, a slot without a reading stays null, and a server with
 * no reading at all is left out.
 */
export function nodeStatsGrid(
  rows: NodeStatsSlotRow[],
  nodes: Array<{ id: string; name: string }>,
  fromMs: number,
  stepSeconds = NODE_STATS_HISTORY_STEP_SECONDS,
  slots = NODE_STATS_HISTORY_SLOTS,
): NodeStatsHistoryServer[] {
  const first = Math.floor(fromMs / 1000 / stepSeconds);
  const blank = (): Array<number | null> => new Array<number | null>(slots).fill(null);
  const byNode = new Map(nodes.map((n) => [n.id, { nodeId: n.id, name: n.name, cpu: blank(), mem: blank(), disk: blank() }]));
  for (const r of rows) {
    const s = byNode.get(r.nodeId);
    const i = Number(r.slot) - first;
    if (!s || i < 0 || i >= slots) continue;
    s.cpu[i] = pct(r.cpu);
    s.mem[i] = pct(r.mem);
    s.disk[i] = pct(r.disk);
  }
  const any = (v: Array<number | null>): boolean => v.some((x) => x !== null);
  return [...byNode.values()].filter((s) => any(s.cpu) || any(s.mem) || any(s.disk)).sort((a, b) => a.name.localeCompare(b.name));
}

export async function nodeStatsHistory(
  ctx: OrgContext,
  input: NodeStatsHistoryInput,
  now = Date.now(),
): Promise<NodeStatsHistoryView> {
  const step = NODE_STATS_HISTORY_STEP_SECONDS;
  const from = diskGridFrom(now, step, NODE_STATS_HISTORY_SLOTS);
  const view = (servers: NodeStatsHistoryServer[]): NodeStatsHistoryView => ({
    from: new Date(from).toISOString(),
    stepSeconds: step,
    fold: 'peak',
    servers,
  });
  const nodes = await ctx.db.node.findMany({
    where: { orgId: ctx.activeOrgId, ...(input.nodeId ? { id: input.nodeId } : {}) },
    select: { id: true, name: true },
  });
  if (nodes.length === 0) return view([]);
  const only = input.nodeId ?? null;
  // `ts` is ISO-8601 text (the bun-sqlite adapter), so strftime reads it and a
  // Date bound parameter compares as the same text. A zero total is no
  // reading (MAX skips the NULL); disk used 0 is no reading too, as in the
  // disk backtest.
  const rows = await telemetryOf(ctx)
    .$queryRaw<NodeStatsSlotRow[]>`
      SELECT "nodeId",
             CAST(strftime('%s', "ts") AS INTEGER) / CAST(${step} AS INTEGER) AS "slot",
             MAX("cpuPercent") AS "cpu",
             MAX(CASE WHEN "memTotalBytes" > 0 THEN CAST("memUsedBytes" AS REAL) * 100.0 / "memTotalBytes" END) AS "mem",
             MAX(CASE WHEN "diskTotalBytes" > 0 AND "diskUsedBytes" > 0
                      THEN CAST("diskUsedBytes" AS REAL) * 100.0 / "diskTotalBytes" END) AS "disk"
      FROM "metric_sample"
      WHERE "orgId" = ${ctx.activeOrgId} AND "scope" = 'NODE'
        AND (${only} IS NULL OR "nodeId" = ${only})
        AND "ts" >= ${new Date(from)}
      GROUP BY 1, 2`
    // telemetry unavailable: no history to draw (the inspector says so).
    .catch(() => [] as NodeStatsSlotRow[]);
  return view(nodeStatsGrid(rows, nodes, from, step));
}
