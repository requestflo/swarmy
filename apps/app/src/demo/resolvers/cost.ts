import type {
  CostNodeView,
  CostOverviewView,
  CostRecommendationView,
  CostStackView,
  CostStorageView,
  SetNodeCostInput,
} from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * Cost demo resolvers — the Cost surface (`/cost`): stat tiles, the per-node
 * table (inline price editing works and re-derives the totals), per-stack
 * estimates, storage and the recommendations feed. Return shapes are imported
 * from @swarmy/core (mirror cost.service exactly, never redeclared). Node ids
 * line up with the seeded demo cluster; three nodes carry costs so the page
 * lands fully lit, two are deliberately unpriced so the "Set cost" affordance
 * and the unpriced-node nudges show too.
 */

interface CostState {
  /** nodeId → monthly USD (the demo's `swarmy.node.cost` labels). */
  prices: Record<string, number>;
  /** nodeId → 7-day average util behind the oversized rule. */
  weekly: Record<string, { cpu: number; mem: number }>;
  idle: Array<{ serviceId: string; name: string; stack: string; avgCpuPct: number }>;
  storage: CostStorageView;
}

function getState(store: DemoStore): CostState {
  return store.extra.cost as CostState;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Stack shares mirror the demo estate: storefront is the big spender. */
const STACK_SHARE: Array<{ stack: string; serviceCount: number; share: number }> = [
  { stack: 'storefront', serviceCount: 4, share: 0.34 },
  { stack: 'data', serviceCount: 4, share: 0.22 },
  { stack: 'platform', serviceCount: 3, share: 0.13 },
];

function nodesView(store: DemoStore): CostNodeView[] {
  const st = getState(store);
  return store.nodes.map((n) => ({
    nodeId: n.id,
    name: n.name,
    online: n.status === 'online' || n.status === 'draining',
    monthlyUsd: st.prices[n.id] ?? null,
    cpuCores: n.resources.cpus,
    memGb: n.resources.memBytes != null ? Math.round((n.resources.memBytes / 1024 ** 3) * 10) / 10 : null,
    cpuUtilPct: n.live?.cpuPercent ?? null,
    memUtilPct: n.live?.memPercent ?? null,
    utilSource: n.live ? 'live' : 'none',
  }));
}

function overviewView(store: DemoStore): CostOverviewView {
  const st = getState(store);
  const nodes = nodesView(store);
  const priced = nodes.filter((n) => n.monthlyUsd != null);
  const monthlyUsd = round2(priced.reduce((a, n) => a + (n.monthlyUsd ?? 0), 0));
  const anyUnpriced = priced.length < nodes.length;

  const stacks: CostStackView[] = STACK_SHARE.map((s) => ({
    stack: s.stack,
    serviceCount: s.serviceCount,
    monthlyUsd: round2(monthlyUsd * s.share),
    partial: anyUnpriced,
  })).sort((a, b) => b.monthlyUsd - a.monthlyUsd);

  const idleServices = st.idle.map((i) => ({
    ...i,
    windowDays: 7,
    estMonthlyUsd: monthlyUsd > 0 ? round2(monthlyUsd * 0.05) : null,
  }));

  const oversizedNodes = Object.entries(st.weekly)
    .filter(([, w]) => w.cpu < 20 && w.mem < 20)
    .map(([nodeId, w]) => {
      const node = nodes.find((n) => n.nodeId === nodeId);
      return {
        nodeId,
        name: node?.name ?? nodeId,
        avgCpuPct: w.cpu,
        avgMemPct: w.mem,
        monthlyUsd: node?.monthlyUsd ?? null,
        windowDays: 7,
      };
    });

  return {
    totals: {
      monthlyUsd,
      pricedNodes: priced.length,
      totalNodes: nodes.length,
      allocatedUsd: round2(stacks.reduce((a, s) => a + s.monthlyUsd, 0)),
      idleServiceCount: idleServices.length,
    },
    nodes,
    stacks,
    idleServices,
    oversizedNodes,
    generatedAt: new Date().toISOString(),
  };
}

/** Mirror of `buildRecommendations` (cost.service.ts) over the demo overview. */
function recommendationsView(store: DemoStore): CostRecommendationView[] {
  const o = overviewView(store);
  const out: CostRecommendationView[] = [];
  for (const n of o.nodes) {
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
        message: `${n.name} is offline but still costs $${n.monthlyUsd}/mo — bring it back or remove it.`,
        savingsUsd: n.monthlyUsd,
      });
    }
  }
  for (const n of o.oversizedNodes) {
    const savings = n.monthlyUsd != null ? round2(n.monthlyUsd / 2) : null;
    out.push({
      id: `oversized-node:${n.nodeId}`,
      kind: 'oversized-node',
      resource: `node ${n.name}`,
      message: `${n.name} averaged ${n.avgCpuPct}% CPU / ${n.avgMemPct}% memory over ${n.windowDays}d — consider a smaller node${savings != null ? ` (save ~$${savings}/mo)` : ''}.`,
      savingsUsd: savings,
    });
  }
  for (const s of o.idleServices) {
    const savings = s.estMonthlyUsd != null && s.estMonthlyUsd > 0 ? s.estMonthlyUsd : null;
    out.push({
      id: `idle-service:${s.serviceId}`,
      kind: 'idle-service',
      resource: `service ${s.name}`,
      message: `${s.name} uses ${s.avgCpuPct}% CPU over ${s.windowDays}d — scale it down or enable scale-to-zero${savings != null ? ` (frees ~$${savings}/mo)` : ''}.`,
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

export const cost: DomainResolvers = {
  handlers: {
    'cost.overview': (_i, s): CostOverviewView => overviewView(s),

    'cost.storage': (_i, s): CostStorageView => getState(s).storage,

    'cost.recommendations': (_i, s): CostRecommendationView[] => recommendationsView(s),

    'cost.setNodeCost': (i, s): { nodeId: string; monthlyUsd: number | null } => {
      const { nodeId, monthlyUsd } = i as SetNodeCostInput;
      const st = getState(s);
      if (monthlyUsd == null) delete st.prices[nodeId];
      else st.prices[nodeId] = monthlyUsd;
      // Mirror the real path: the price is a node label (`swarmy.node.cost`).
      const node = s.nodes.find((n) => n.id === nodeId);
      if (node) {
        node.labels = { ...(node.labels ?? {}), 'swarmy.node.cost': monthlyUsd == null ? '' : String(monthlyUsd) };
      }
      return { nodeId, monthlyUsd };
    },
  },

  seed: (store) => {
    // Three priced nodes (the manifest's "3 nodes w/ costs"), two left unpriced
    // so the inline editor + unpriced nudges are visible. wkr-3 idles under 20%
    // in its 7-day averages → the oversized rule fires with a save-~$18 guess.
    const state: CostState = {
      prices: { 'n-mgr-1': 24, 'n-wkr-1': 48, 'n-wkr-3': 36 },
      weekly: {
        'n-mgr-1': { cpu: 31, mem: 48 },
        'n-wkr-1': { cpu: 58, mem: 66 },
        'n-wkr-3': { cpu: 9.4, mem: 14.2 },
      },
      idle: [
        { serviceId: 'svc-nats', name: 'nats', stack: 'data', avgCpuPct: 0.6 },
        { serviceId: 'svc-loki', name: 'loki', stack: 'platform', avgCpuPct: 1.3 },
      ],
      storage: {
        garageState: 'ready',
        bucketCount: 3,
        objectCount: 18_240,
        usageBytes: 47.3 * 1024 ** 3,
        volumeCount: 4,
      },
    };
    // Stamp the labels onto the demo nodes so other surfaces stay coherent.
    for (const node of store.nodes) {
      const usd = state.prices[node.id];
      if (usd != null) node.labels = { ...(node.labels ?? {}), 'swarmy.node.cost': String(usd) };
    }
    store.extra.cost = state;
  },
};
