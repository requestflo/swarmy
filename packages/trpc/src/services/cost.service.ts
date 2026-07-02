import {
  buildInventory,
  type CostIdleServiceView,
  type CostNodeView,
  type CostOverviewView,
  type CostOversizedNodeView,
  type CostRecommendationView,
  type CostStackView,
  type CostStorageView,
  type CostUtilSource,
  type SetNodeCostInput,
} from '@swarmy/core';
import type { OrgContext } from '../context';
import { notFound } from '../errors';
import { writeAudit } from './audit.service';
import { overview as bucketsOverview } from './buckets.service';

/**
 * Cost & capacity (slice F1) — what the estate costs and where it's wasted.
 *
 * Pricing is Docker-truth: each node's monthly price is the `swarmy.node.cost`
 * node label (USD, plain decimal string), written via the `node.update`
 * command exactly like the region/role/canvas labels in node.service — never a
 * DB column. Everything else here is derived on read:
 *
 *   - node utilization: the live hub snapshot (`ctx.hub.latestNodeStats`, the
 *     same source the Nodes page shows), falling back to a recent MetricSample
 *     average when the node is quiet/offline;
 *   - per-stack cost: the pure memory-share estimator below;
 *   - idle services / oversized nodes: 7-day MetricSample averages.
 *
 * ── Estimation formula (documented per the manifest) ──────────────────────────
 * For every container on a priced node:
 *
 *     weight = reservedBytes / nodeMemTotalBytes
 *     where reservedBytes = memLimitBytes   if 0 < memLimitBytes < nodeMemTotalBytes
 *                         = memUsedBytes    otherwise (no real limit configured —
 *                           Docker reports the host total as the "limit")
 *     containerMonthlyUsd = weight × nodeMonthlyUsd
 *
 * A stack's estimated monthly cost is the sum of containerMonthlyUsd over every
 * container of its services, across all nodes. Shares are intentionally NOT
 * normalised: unallocated node capacity stays unattributed — that gap between
 * `totals.monthlyUsd` and `totals.allocatedUsd` is your headroom/waste signal.
 * Containers on unpriced nodes contribute $0 and mark the stack `partial`.
 */

/** Node label carrying the monthly price in USD (Docker-truth, no DB column). */
export const NODE_COST_LABEL = 'swarmy.node.cost';

/** Services averaging below this CPU% over the window count as idle. */
export const IDLE_CPU_PCT = 2;
/** Nodes with BOTH cpu and mem averages below this count as oversized. */
export const OVERSIZED_UTIL_PCT = 20;
/** Observation window for idle/oversized detection. */
export const WINDOW_DAYS = 7;
/** Minimum history samples before we trust a 7-day average. */
const MIN_SAMPLES = 12;
/** "Recent" window for the MetricSample utilization fallback. */
const RECENT_UTIL_MS = 15 * 60_000;

// ── Pure: label codec ─────────────────────────────────────────────────────────

/** Parse the `swarmy.node.cost` label → monthly USD, or null when unset/garbage. */
export function parseNodeCost(labels: Record<string, string> | undefined): number | null {
  const raw = labels?.[NODE_COST_LABEL];
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/** Encode a monthly USD price for the label (null → '' clears; merge-only labels). */
export function encodeNodeCost(monthlyUsd: number | null): string {
  return monthlyUsd == null ? '' : String(Math.round(monthlyUsd * 100) / 100);
}

// ── Pure: per-stack estimation ────────────────────────────────────────────────

export interface CostNodeInput {
  nodeId: string;
  monthlyUsd: number | null;
  memTotalBytes: number;
}

export interface CostContainerInput {
  nodeId: string;
  serviceId: string;
  memLimitBytes: number;
  memUsedBytes: number;
}

export interface ServiceMeta {
  name: string;
  stack: string;
}

export interface StackCostEstimate {
  stacks: CostStackView[];
  /** Per-service attributed monthly USD (feeds idle-service savings guesses). */
  serviceMonthlyUsd: Record<string, number>;
  /** Sum of every stack's estimate — the attributed share of total spend. */
  allocatedUsd: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * The memory-share cost estimator (formula documented in the file header).
 * Pure: nodes + container samples + service→stack metadata in, stack costs out.
 */
export function estimateStackCosts(
  nodes: CostNodeInput[],
  containers: CostContainerInput[],
  services: Map<string, ServiceMeta>,
): StackCostEstimate {
  const nodeById = new Map(nodes.map((n) => [n.nodeId, n]));
  const serviceUsd = new Map<string, number>();
  const partialServices = new Set<string>();

  for (const c of containers) {
    const meta = services.get(c.serviceId);
    if (!meta) continue; // not a swarm service container (or already gone)
    const node = nodeById.get(c.nodeId);
    if (!node || node.memTotalBytes <= 0) continue;
    if (node.monthlyUsd == null) {
      partialServices.add(c.serviceId);
      continue; // unpriced node → contributes $0, flags the stack partial
    }
    // Reservation: the configured memory limit when one exists; Docker reports
    // the host total when unlimited, so a "limit" >= node memory means none.
    const reserved =
      c.memLimitBytes > 0 && c.memLimitBytes < node.memTotalBytes
        ? c.memLimitBytes
        : c.memUsedBytes;
    const weight = Math.min(Math.max(reserved, 0), node.memTotalBytes) / node.memTotalBytes;
    serviceUsd.set(c.serviceId, (serviceUsd.get(c.serviceId) ?? 0) + weight * node.monthlyUsd);
  }

  const byStack = new Map<string, { usd: number; serviceIds: Set<string>; partial: boolean }>();
  for (const [serviceId, meta] of services) {
    const usd = serviceUsd.get(serviceId);
    const partial = partialServices.has(serviceId);
    if (usd == null && !partial) continue; // no running containers observed
    const entry = byStack.get(meta.stack) ?? { usd: 0, serviceIds: new Set<string>(), partial: false };
    entry.usd += usd ?? 0;
    entry.serviceIds.add(serviceId);
    entry.partial = entry.partial || partial;
    byStack.set(meta.stack, entry);
  }

  const stacks: CostStackView[] = [...byStack.entries()]
    .map(([stack, e]) => ({
      stack,
      serviceCount: e.serviceIds.size,
      monthlyUsd: round2(e.usd),
      partial: e.partial,
    }))
    .sort((a, b) => b.monthlyUsd - a.monthlyUsd || a.stack.localeCompare(b.stack));

  const serviceMonthlyUsd: Record<string, number> = {};
  for (const [id, usd] of serviceUsd) serviceMonthlyUsd[id] = round2(usd);

  return {
    stacks,
    serviceMonthlyUsd,
    allocatedUsd: round2(stacks.reduce((a, s) => a + s.monthlyUsd, 0)),
  };
}

// ── Pure: recommendation rules ────────────────────────────────────────────────

export interface RecommendationInput {
  nodes: CostNodeView[];
  oversizedNodes: CostOversizedNodeView[];
  idleServices: CostIdleServiceView[];
}

const usd = (n: number): string => `$${round2(n)}`;

/**
 * The rule list behind the recommendations feed. Each rule yields a stable id
 * (the UI's localStorage dismiss key), a human sentence and a savings guess.
 * Sorted biggest saving first; setup nudges (no guess) sink to the bottom.
 */
export function buildRecommendations(input: RecommendationInput): CostRecommendationView[] {
  const out: CostRecommendationView[] = [];

  for (const n of input.nodes) {
    if (n.monthlyUsd == null) {
      out.push({
        id: `unpriced-node:${n.nodeId}`,
        kind: 'unpriced-node',
        resource: `node ${n.name}`,
        message: `${n.name} has no monthly cost set — add one to unlock per-stack breakdowns and savings estimates.`,
        savingsUsd: null,
      });
    } else if (!n.online && n.monthlyUsd > 0) {
      out.push({
        id: `offline-node:${n.nodeId}`,
        kind: 'offline-node',
        resource: `node ${n.name}`,
        message: `${n.name} is offline but still costs ${usd(n.monthlyUsd)}/mo — bring it back or remove it.`,
        savingsUsd: round2(n.monthlyUsd),
      });
    }
  }

  for (const n of input.oversizedNodes) {
    // Savings guess: dropping one instance size roughly halves the bill.
    const savings = n.monthlyUsd != null ? round2(n.monthlyUsd / 2) : null;
    out.push({
      id: `oversized-node:${n.nodeId}`,
      kind: 'oversized-node',
      resource: `node ${n.name}`,
      message: `${n.name} averaged ${round2(n.avgCpuPct)}% CPU / ${round2(n.avgMemPct)}% memory over ${n.windowDays}d — consider a smaller node${savings != null ? ` (save ~${usd(savings)}/mo)` : ''}.`,
      savingsUsd: savings,
    });
  }

  for (const s of input.idleServices) {
    const savings = s.estMonthlyUsd != null && s.estMonthlyUsd > 0 ? round2(s.estMonthlyUsd) : null;
    out.push({
      id: `idle-service:${s.serviceId}`,
      kind: 'idle-service',
      resource: `service ${s.name}`,
      message: `${s.name} uses ${round2(s.avgCpuPct)}% CPU${s.windowDays > 0 ? ` over ${s.windowDays}d` : ''} — scale it down or enable scale-to-zero${savings != null ? ` (frees ~${usd(savings)}/mo)` : ''}.`,
      savingsUsd: savings,
    });
  }

  return out.sort((a, b) => {
    if (a.savingsUsd == null && b.savingsUsd == null) return a.resource.localeCompare(b.resource);
    if (a.savingsUsd == null) return 1;
    if (b.savingsUsd == null) return -1;
    return b.savingsUsd - a.savingsUsd;
  });
}

// ── Utilization (live hub snapshot, MetricSample fallback) ────────────────────

interface NodeUtil {
  cpuUtilPct: number | null;
  memUtilPct: number | null;
  source: CostUtilSource;
}

/** Live util from the hub (same accessor the Nodes page uses), else a recent
 *  MetricSample average, else nothing. */
async function nodeUtil(ctx: OrgContext, nodeId: string): Promise<NodeUtil> {
  if (ctx.hub.isOnline(nodeId)) {
    const s = ctx.hub.latestNodeStats(nodeId);
    if (s) {
      return {
        cpuUtilPct: s.cpuPercent,
        memUtilPct: s.memTotalBytes > 0 ? (s.memUsedBytes / s.memTotalBytes) * 100 : 0,
        source: 'live',
      };
    }
  }
  const agg = await ctx.db.metricSample.aggregate({
    where: {
      orgId: ctx.activeOrgId,
      nodeId,
      scope: 'NODE',
      ts: { gte: new Date(Date.now() - RECENT_UTIL_MS) },
    },
    _avg: { cpuPercent: true, memUsedBytes: true, memTotalBytes: true },
  });
  const cpu = agg._avg.cpuPercent;
  const memUsed = agg._avg.memUsedBytes;
  const memTotal = agg._avg.memTotalBytes;
  if (cpu == null) return { cpuUtilPct: null, memUtilPct: null, source: 'none' };
  return {
    cpuUtilPct: cpu,
    memUtilPct: memTotal != null && Number(memTotal) > 0 ? (Number(memUsed ?? 0) / Number(memTotal)) * 100 : null,
    source: 'history',
  };
}

// ── The overview query ────────────────────────────────────────────────────────

export async function overview(ctx: OrgContext): Promise<CostOverviewView> {
  const rows = await ctx.db.node.findMany({
    where: { orgId: ctx.activeOrgId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true },
  });

  // Per-node view: price label + capacity from live swarm info + utilization.
  const nodes: CostNodeView[] = [];
  for (const r of rows) {
    const info = ctx.hub.nodeInfoFor(r.id);
    const util = await nodeUtil(ctx, r.id);
    nodes.push({
      nodeId: r.id,
      name: r.name,
      online: ctx.hub.isOnline(r.id),
      monthlyUsd: parseNodeCost(info?.labels),
      cpuCores: info?.cpus ?? null,
      memGb: info?.memBytes != null ? Math.round((info.memBytes / 1024 ** 3) * 10) / 10 : null,
      cpuUtilPct: util.cpuUtilPct,
      memUtilPct: util.memUtilPct,
      utilSource: util.source,
    });
  }

  // Service → stack metadata from the live inventory (Docker truth).
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  const inv = buildInventory(services, containers).services;
  const serviceMeta = new Map<string, ServiceMeta>(
    inv.map((s) => [s.id, { name: s.name, stack: s.stack }]),
  );

  // Container samples per node: join the hub's container list (carries the
  // serviceId) with its stats ring (carries mem usage/limit).
  const costNodes: CostNodeInput[] = [];
  const costContainers: CostContainerInput[] = [];
  for (const n of nodes) {
    const info = ctx.hub.nodeInfoFor(n.nodeId);
    const memTotal = info?.memBytes ?? ctx.hub.latestNodeStats(n.nodeId)?.memTotalBytes ?? 0;
    costNodes.push({ nodeId: n.nodeId, monthlyUsd: n.monthlyUsd, memTotalBytes: memTotal });
    if (!n.online) continue;
    const list = ctx.hub.latestContainers(n.nodeId);
    const stats = new Map(ctx.hub.latestContainerStats(n.nodeId).map((s) => [s.containerId, s]));
    for (const c of list) {
      const serviceId = c.serviceId ?? c.labels?.['com.docker.swarm.service.id'];
      if (!serviceId) continue;
      const s = stats.get(c.id) ?? stats.get(c.id.slice(0, 12));
      if (!s) continue;
      costContainers.push({
        nodeId: n.nodeId,
        serviceId,
        memLimitBytes: s.memLimitBytes,
        memUsedBytes: s.memUsedBytes,
      });
    }
  }
  const estimate = estimateStackCosts(costNodes, costContainers, serviceMeta);

  const [idleServices, oversizedNodes] = await Promise.all([
    findIdleServices(ctx, inv, estimate.serviceMonthlyUsd),
    findOversizedNodes(ctx, nodes),
  ]);

  const priced = nodes.filter((n) => n.monthlyUsd != null);
  return {
    totals: {
      monthlyUsd: round2(priced.reduce((a, n) => a + (n.monthlyUsd ?? 0), 0)),
      pricedNodes: priced.length,
      totalNodes: nodes.length,
      allocatedUsd: estimate.allocatedUsd,
      idleServiceCount: idleServices.length,
    },
    nodes,
    stacks: estimate.stacks,
    idleServices,
    oversizedNodes,
    generatedAt: new Date().toISOString(),
  };
}

/** Services averaging < IDLE_CPU_PCT CPU over WINDOW_DAYS (MetricSample CONTAINER
 *  scope; falls back to the live container-stats snapshot for services without
 *  history — flagged with windowDays 0). Intentionally-idle services
 *  (scale-to-zero, stopped) are excluded. */
async function findIdleServices(
  ctx: OrgContext,
  inv: ReturnType<typeof buildInventory>['services'],
  serviceMonthlyUsd: Record<string, number>,
): Promise<CostIdleServiceView[]> {
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60_000);
  const history = new Map<string, number>();
  try {
    const grouped = await ctx.db.metricSample.groupBy({
      by: ['serviceId'],
      where: {
        orgId: ctx.activeOrgId,
        scope: 'CONTAINER',
        serviceId: { not: null },
        ts: { gte: since },
      },
      _avg: { cpuPercent: true },
      _count: { _all: true },
    });
    for (const g of grouped) {
      if (g.serviceId && g._count._all >= MIN_SAMPLES && g._avg.cpuPercent != null) {
        history.set(g.serviceId, g._avg.cpuPercent);
      }
    }
  } catch {
    // container-scope samples may not exist yet — live fallback below.
  }

  // Live fallback: average current container CPU per service, across nodes.
  const live = new Map<string, { sum: number; count: number }>();
  for (const nodeId of ctx.hub.onlineNodeIds()) {
    const byId = new Map(ctx.hub.latestContainerStats(nodeId).map((s) => [s.containerId, s]));
    for (const c of ctx.hub.latestContainers(nodeId)) {
      const serviceId = c.serviceId ?? c.labels?.['com.docker.swarm.service.id'];
      if (!serviceId) continue;
      const s = byId.get(c.id) ?? byId.get(c.id.slice(0, 12));
      if (!s) continue;
      const entry = live.get(serviceId) ?? { sum: 0, count: 0 };
      entry.sum += s.cpuPercent;
      entry.count += 1;
      live.set(serviceId, entry);
    }
  }

  const out: CostIdleServiceView[] = [];
  for (const svc of inv) {
    if (svc.scaleToZero || svc.replicas.running === 0) continue;
    const hist = history.get(svc.id);
    const liveEntry = live.get(svc.id);
    const avg = hist ?? (liveEntry && liveEntry.count > 0 ? liveEntry.sum / liveEntry.count : null);
    if (avg == null || avg >= IDLE_CPU_PCT) continue;
    out.push({
      serviceId: svc.id,
      name: svc.name,
      stack: svc.stack,
      avgCpuPct: round2(avg),
      windowDays: hist != null ? WINDOW_DAYS : 0,
      estMonthlyUsd: serviceMonthlyUsd[svc.id] ?? null,
    });
  }
  return out.sort((a, b) => a.avgCpuPct - b.avgCpuPct);
}

/** Nodes whose cpu AND mem averaged < OVERSIZED_UTIL_PCT over WINDOW_DAYS of
 *  MetricSample NODE history (needs MIN_SAMPLES so fresh nodes aren't flagged). */
async function findOversizedNodes(
  ctx: OrgContext,
  nodes: CostNodeView[],
): Promise<CostOversizedNodeView[]> {
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60_000);
  const grouped = await ctx.db.metricSample.groupBy({
    by: ['nodeId'],
    where: { orgId: ctx.activeOrgId, scope: 'NODE', ts: { gte: since } },
    _avg: { cpuPercent: true, memUsedBytes: true, memTotalBytes: true },
    _count: { _all: true },
  });
  const byNode = new Map(nodes.map((n) => [n.nodeId, n]));
  const out: CostOversizedNodeView[] = [];
  for (const g of grouped) {
    const node = byNode.get(g.nodeId);
    if (!node || !node.online) continue;
    if (g._count._all < MIN_SAMPLES || g._avg.cpuPercent == null) continue;
    const memTotal = Number(g._avg.memTotalBytes ?? 0);
    const memPct = memTotal > 0 ? (Number(g._avg.memUsedBytes ?? 0) / memTotal) * 100 : 0;
    if (g._avg.cpuPercent >= OVERSIZED_UTIL_PCT || memPct >= OVERSIZED_UTIL_PCT) continue;
    out.push({
      nodeId: g.nodeId,
      name: node.name,
      avgCpuPct: round2(g._avg.cpuPercent),
      avgMemPct: round2(memPct),
      monthlyUsd: node.monthlyUsd,
      windowDays: WINDOW_DAYS,
    });
  }
  return out.sort((a, b) => (b.monthlyUsd ?? 0) - (a.monthlyUsd ?? 0));
}

// ── Mutations ─────────────────────────────────────────────────────────────────

/** Write the `swarmy.node.cost` label via `node.update` (Docker truth; merged
 *  labels can't be deleted, so clearing writes ''). Best-effort while offline —
 *  mirrors node.service label writers. Audited. */
export async function setNodeCost(
  ctx: OrgContext,
  input: SetNodeCostInput,
): Promise<{ nodeId: string; monthlyUsd: number | null }> {
  const node = await ctx.db.node.findFirst({
    where: { id: input.nodeId, orgId: ctx.activeOrgId },
    select: { id: true, name: true },
  });
  if (!node) throw notFound('node', input.nodeId);

  const patch = { [NODE_COST_LABEL]: encodeNodeCost(input.monthlyUsd) };
  const swarmNodeId = ctx.hub.swarmNodeIdFor(node.id);
  if (ctx.hub.isOnline(node.id) && swarmNodeId) {
    await ctx.hub
      .dispatch(node.id, 'node.update', { swarmNodeId, labels: patch })
      .catch(() => undefined);
  }
  await writeAudit(ctx, {
    action: 'cost.node.set',
    targetType: 'node',
    targetId: node.id,
    metadata: { name: node.name, monthlyUsd: input.monthlyUsd },
  });
  return { nodeId: node.id, monthlyUsd: input.monthlyUsd };
}

// ── Storage + recommendations queries ─────────────────────────────────────────

/** Garage usage (via the A4 buckets service — it already degrades gracefully
 *  when the store is disabled/unreachable) + registered cluster-volume count. */
export async function storage(ctx: OrgContext): Promise<CostStorageView> {
  const [garage, volumeCount] = await Promise.all([
    bucketsOverview(ctx).catch(() => null),
    ctx.db.clusterVolume.count({ where: { orgId: ctx.activeOrgId } }).catch(() => 0),
  ]);
  const buckets = garage?.buckets ?? [];
  return {
    garageState: garage?.state ?? 'disabled',
    bucketCount: buckets.length,
    objectCount: buckets.reduce((a, b) => a + b.objects, 0),
    usageBytes: buckets.reduce((a, b) => a + b.usageBytes, 0),
    volumeCount,
  };
}

/** The recommendations feed: rule list over the current overview. */
export async function recommendations(ctx: OrgContext): Promise<CostRecommendationView[]> {
  const o = await overview(ctx);
  return buildRecommendations({
    nodes: o.nodes,
    oversizedNodes: o.oversizedNodes,
    idleServices: o.idleServices,
  });
}
