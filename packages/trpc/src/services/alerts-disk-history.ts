import type { AlertDiskHistoryInput, AlertDiskHistoryView } from '@swarmy/core';
import { telemetryOf, type OrgContext } from '../context';

/**
 * `alerts.diskHistory` — what a disk rule would have seen over the last week,
 * for the rule editor's "would have fired" backtest. Read-only, org-scoped:
 * the server list is the org's own enrolment rows, the samples are filtered on
 * `orgId`, and a sample for any other node is dropped. telemetry.db keeps one
 * NODE row per server per minute (metrics-sampler); the SQL folds them into
 * 5-minute peaks so a big estate never ships ~10k rows per server.
 */

export const DISK_HISTORY_DAYS = 7;
export const DISK_HISTORY_STEP_SECONDS = 300;
const SLOTS = (DISK_HISTORY_DAYS * 86_400) / DISK_HISTORY_STEP_SECONDS;

/** One SQL row: a node's fullest reading (% used) in one slot (epoch seconds ÷ step). */
export interface DiskSlotRow {
  nodeId: string;
  slot: number | bigint;
  peak: number;
}

/** The first slot's start (ms) of a grid that ends with the slot holding `now`. */
export function diskGridFrom(now: number, stepSeconds = DISK_HISTORY_STEP_SECONDS, slots = SLOTS): number {
  return (Math.floor(now / 1000 / stepSeconds) - slots + 1) * stepSeconds * 1000;
}

/**
 * Slot rows → one fixed grid per server, by name. Pure. Only `nodes` (the
 * org's own) appear, a slot without a sample stays null, and a server with
 * no sample at all is left out.
 */
export function diskPeaksGrid(
  rows: DiskSlotRow[],
  nodes: Array<{ id: string; name: string }>,
  fromMs: number,
  stepSeconds = DISK_HISTORY_STEP_SECONDS,
  slots = SLOTS,
): AlertDiskHistoryView['servers'] {
  const first = Math.floor(fromMs / 1000 / stepSeconds);
  const byNode = new Map(nodes.map((n) => [n.id, { name: n.name, peaks: new Array<number | null>(slots).fill(null) }]));
  for (const r of rows) {
    const s = byNode.get(r.nodeId);
    const i = Number(r.slot) - first;
    const peak = Number(r.peak);
    if (!s || i < 0 || i >= slots || !Number.isFinite(peak)) continue;
    s.peaks[i] = Math.round(peak * 10) / 10;
  }
  return [...byNode.values()].filter((s) => s.peaks.some((v) => v !== null)).sort((a, b) => a.name.localeCompare(b.name));
}

export async function diskHistory(
  ctx: OrgContext,
  input: AlertDiskHistoryInput,
  now = Date.now(),
): Promise<AlertDiskHistoryView> {
  const step = DISK_HISTORY_STEP_SECONDS;
  const from = diskGridFrom(now);
  const view = (servers: AlertDiskHistoryView['servers']): AlertDiskHistoryView => ({ from: new Date(from).toISOString(), stepSeconds: step, servers });
  const nodes = await ctx.db.node.findMany({
    where: { orgId: ctx.activeOrgId, ...(input.server ? { name: input.server } : {}) },
    select: { id: true, name: true },
  });
  if (nodes.length === 0) return view([]);
  // `ts` is ISO-8601 text (the bun-sqlite adapter), so strftime reads it and a
  // Date bound parameter compares as the same text. Used 0 = no reading (the
  // evaluator skips it too).
  const rows = await telemetryOf(ctx)
    .$queryRaw<DiskSlotRow[]>`
      SELECT "nodeId",
             CAST(strftime('%s', "ts") AS INTEGER) / CAST(${step} AS INTEGER) AS "slot",
             MAX(CAST("diskUsedBytes" AS REAL) * 100.0 / "diskTotalBytes") AS "peak"
      FROM "metric_sample"
      WHERE "orgId" = ${ctx.activeOrgId} AND "scope" = 'NODE' AND "diskTotalBytes" > 0 AND "diskUsedBytes" > 0
        AND "ts" >= ${new Date(from)}
      GROUP BY 1, 2`
    // telemetry unavailable: no history to replay (the editor says so).
    .catch(() => [] as DiskSlotRow[]);
  return view(diskPeaksGrid(rows, nodes, from, step));
}
