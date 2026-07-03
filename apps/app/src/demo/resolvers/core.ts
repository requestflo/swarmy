import type { DeployPhase, DeployStatus, NodeSummary, ServiceSummary } from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * Core demo resolvers — the flagship surfaces (command bar, Applications canvas,
 * Infrastructure plane, service/node detail). Other routers are covered by their
 * own resolver modules; anything unhandled falls back gracefully.
 */

const jitter = (base: number, spread = 6) => Math.max(2, Math.min(98, base + (Math.random() - 0.5) * spread));

function byId<T extends { id: string }>(arr: T[], id: string): T | undefined {
  return arr.find((x) => x.id === id);
}

export const core: DomainResolvers = {
  handlers: {
    'org.currentOrg': (_i, s) => ({ id: s.org.id, name: s.org.name, slug: s.org.slug, role: s.org.role }),
    'org.whoami': (_i, s) => ({ id: s.user.id, name: s.user.name, email: s.user.email }),

    'system.dashboardSummary': (_i, s) => {
      const online = s.nodes.filter((n) => n.status === 'online').length;
      const running = s.services.filter((sv) => sv.status === 'running').length;
      const containers = s.services.reduce((a, sv) => a + sv.replicas.running, 0);
      return {
        nodes: { online, total: s.nodes.length },
        services: { running, total: s.services.length },
        containersRunning: containers,
        recentDeployments: 7,
      };
    },
    'metrics.overview': (_i, s) => {
      const live = s.nodes.filter((n) => n.live);
      const cpu = live.reduce((a, n) => a + (n.live?.cpuPercent ?? 0), 0) / Math.max(1, live.length);
      const mem = live.reduce((a, n) => a + (n.live?.memPercent ?? 0), 0) / Math.max(1, live.length);
      return { cpuPercent: jitter(cpu), memPercent: jitter(mem, 3) };
    },

    'nodes.list': (_i, s): NodeSummary[] => s.nodes,
    'nodes.get': (i, s) => byId(s.nodes, (i as { id: string }).id) ?? null,
    'nodes.liveStatsLatest': (i, s) => {
      const n = byId(s.nodes, (i as { id?: string })?.id ?? '');
      if (!n?.live) return null;
      return { cpuPercent: jitter(n.live.cpuPercent), memPercent: jitter(n.live.memPercent, 3) };
    },
    'nodes.containers': (i, s) => {
      const id = (i as { id?: string })?.id;
      return s.services
        .filter((sv) => sv.nodeId === id)
        .map((sv) => ({ id: `ctr-${sv.id}`, name: sv.name, image: sv.image, state: 'running' }));
    },
    // Labels editor on the node page: '' values are deletions (mirrors the real
    // node.update label patch convention).
    'nodes.setLabels': (i, s) => {
      const { id, labels } = i as { id: string; labels: Record<string, string> };
      const n = byId(s.nodes, id) as (NodeSummary & { labels?: Record<string, string> }) | undefined;
      if (n) {
        const next = { ...(n.labels ?? {}) };
        for (const [k, v] of Object.entries(labels)) {
          if (v === '') delete next[k];
          else next[k] = v;
        }
        n.labels = next;
      }
      return { id };
    },
    'nodes.remove': (i, s) => {
      const { id } = i as { id: string };
      s.nodes = s.nodes.filter((n) => n.id !== id);
      return { id };
    },
    'nodes.drain': (i, s) => {
      const n = byId(s.nodes, (i as { id: string }).id);
      if (n) n.status = 'draining';
      return { id: (i as { id: string }).id };
    },
    'nodes.activate': (i, s) => {
      const n = byId(s.nodes, (i as { id: string }).id);
      if (n) n.status = 'online';
      return { id: (i as { id: string }).id };
    },
    // Edge/geo: node roles (ingress/outlet), region, and canvas position — all
    // mirror the real handlers (Docker node labels) so the Infrastructure canvas +
    // globe are interactive under ?demo=1.
    'nodes.setRole': (i, s) => {
      const { id, ingress, outlet } = i as { id: string; ingress?: boolean; outlet?: boolean };
      const n = byId(s.nodes, id) as (NodeSummary & { labels?: Record<string, string> }) | undefined;
      if (n) {
        if (ingress !== undefined) n.ingress = ingress;
        if (outlet !== undefined) n.outlet = outlet;
        n.labels = { ...(n.labels ?? {}) };
        if (ingress !== undefined) n.labels['swarmy.node.ingress'] = String(ingress);
        if (outlet !== undefined) n.labels['swarmy.node.outlet'] = String(outlet);
      }
      return { id };
    },
    'nodes.setRegion': (i, s) => {
      const { id, region } = i as { id: string; region: string };
      const n = byId(s.nodes, id) as (NodeSummary & { labels?: Record<string, string> }) | undefined;
      if (n) {
        n.region = region;
        n.labels = { ...(n.labels ?? {}), 'swarmy.region': region };
      }
      return { id, region };
    },
    'nodes.setCanvasPosition': (i) => {
      const { id } = i as { id: string; x: number; y: number };
      return { id };
    },
    'nodes.canvasPositions': () => ({}) as Record<string, { x: number; y: number }>,
    // Container count per node for the index list row — mirrors nodes.containers'
    // service-as-container placement so the two stay coherent under ?demo=1.
    'nodes.containerCounts': (_i, s) => {
      const counts: Record<string, number> = {};
      for (const n of s.nodes) counts[n.id] = s.services.filter((sv) => sv.nodeId === n.id).length;
      return counts;
    },
    // Mirrors cost.setNodeCost (same `swarmy.node.cost` label + the cost
    // resolver's `st.prices` map) so the Nodes page and /cost stay in sync.
    'nodes.setCost': (i, s): { id: string; monthlyUsd: number | null } => {
      const { id, monthlyUsd } = i as { id: string; monthlyUsd: number | null };
      const st = s.extra.cost as { prices: Record<string, number> } | undefined;
      if (st) {
        if (monthlyUsd == null) delete st.prices[id];
        else st.prices[id] = monthlyUsd;
      }
      const n = byId(s.nodes, id) as (NodeSummary & { labels?: Record<string, string> }) | undefined;
      if (n) {
        n.labels = { ...(n.labels ?? {}), 'swarmy.node.cost': monthlyUsd == null ? '' : String(monthlyUsd) };
      }
      return { id, monthlyUsd };
    },

    'services.list': (i, s): ServiceSummary[] => {
      const f = (i as { nodeId?: string; stackId?: string; status?: string; search?: string }) ?? {};
      return s.services.filter(
        (sv) =>
          (!f.nodeId || sv.nodeId === f.nodeId) &&
          (!f.stackId || sv.stackId === f.stackId) &&
          (!f.status || sv.status === f.status) &&
          (!f.search || sv.name.includes(f.search) || sv.image.includes(f.search)),
      );
    },
    'services.get': (i, s) => byId(s.services, (i as { id: string }).id) ?? null,
    // Synthesized from the service's live replica counts (no Deployment row in the
    // backendless demo), mirroring the controller's new inventory-derived status:
    // `complete` once running >= desired, else still `converging`.
    'services.deployStatus': (i, s): DeployStatus | null => {
      const sv = byId(s.services, (i as { serviceId: string }).serviceId);
      if (!sv) return null;
      const { desired, running } = sv.replicas;
      const phase: DeployPhase =
        sv.status === 'failed' ? 'failed' : running >= desired ? 'complete' : 'converging';
      return {
        deploymentId: `dep-${sv.id}`,
        serviceId: sv.id,
        kind: 'update',
        phase,
        desired,
        ready: running,
        message: null,
        startedAt: sv.updatedAt,
        finishedAt: phase === 'complete' ? sv.updatedAt : null,
      };
    },
    'services.scale': (i, s) => {
      const { id, replicas } = i as { id: string; replicas: number };
      const sv = byId(s.services, id);
      if (sv) {
        sv.replicas = { desired: replicas, running: replicas };
        sv.status = replicas === 0 ? 'stopped' : 'running';
        sv.updatedAt = new Date().toISOString();
      }
      return { id, deploymentId: `dep-${Math.random().toString(36).slice(2, 8)}` };
    },
    'services.restart': (i, s) => {
      const sv = byId(s.services, (i as { id: string }).id);
      if (sv) {
        sv.status = 'running';
        sv.replicas.running = sv.replicas.desired;
        sv.updatedAt = new Date().toISOString();
      }
      return { id: (i as { id: string }).id, deploymentId: `dep-${Math.random().toString(36).slice(2, 8)}` };
    },
    'services.remove': (i, s) => {
      const { id } = i as { id: string };
      s.services = s.services.filter((sv) => sv.id !== id);
      delete s.positions[id];
      return { id, removed: true as const };
    },
    'services.create': (i, s) => {
      const b = i as { name: string; image: string; replicas?: number; nodeId?: string };
      const id = `svc-${b.name}-${Math.random().toString(36).slice(2, 6)}`;
      s.services.push({
        id,
        name: b.name,
        image: b.image,
        status: 'deploying',
        replicas: { desired: b.replicas ?? 1, running: 0 },
        ingressEnabled: false,
        nodeId: b.nodeId ?? null,
        stackId: null,
        updatedAt: new Date().toISOString(),
        env: {},
        ports: [],
        volumes: [],
        networks: ['swarmy_public'],
        constraints: [],
        swarmServiceId: `svc-${id}`,
        createdAt: new Date().toISOString(),
      });
      return { id, deploymentId: `dep-${Math.random().toString(36).slice(2, 8)}` };
    },

    'stacks.list': (_i, s) => s.stacks,
    'stacks.remove': (i, s) => {
      const { id } = i as { id: string };
      const target = s.stacks.find((st) => st.id === id);
      if (target?.name === 'swarmy-system') {
        throw new Error('swarmy-system is managed by swarmy and cannot be removed');
      }
      s.stacks = s.stacks.filter((st) => st.id !== id);
      return { id, removed: true as const };
    },
    'stacks.deployFromCompose': () => ({ ok: true as const, deploymentId: 'dep-demo' }),

    'canvas.get': (_i, s) => ({ positions: s.positions, viewport: s.viewport }),
    'canvas.save': (i, s) => {
      const b = i as { positions?: Record<string, { x: number; y: number }>; viewport?: { x: number; y: number; zoom: number } | null };
      if (b.positions) s.positions = b.positions;
      if (b.viewport !== undefined) s.viewport = b.viewport ?? null;
      return { ok: true as const };
    },
  },
};

// re-export the store type for resolver authors that import from here
export type { DemoStore };
