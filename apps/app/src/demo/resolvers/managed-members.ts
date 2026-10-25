import type { CacheClusterView, NodeSummary, SearchInstanceView, ServiceSummary, ServiceUsageView } from '@swarmy/core';
import type { DemoStore } from '../types';

/**
 * The managed-data members (Postgres primaries and standbys, cache members,
 * search instances) as swarm services, for the name-scoped `services.list`
 * queries the per-database page and the cache card make — `{ nodeId, search }`
 * per server, the same placement filter production answers from the live
 * tasks. The default lists keep leaving them out (the stories built on those
 * predate this), so only a search by name finds them.
 *
 * The story: checkout's main copy is on wkr-1 (us-east), its one running
 * standby on mgr-2 (eu-west); storefront's cache primary is pinned to wkr-2,
 * its standbys on wkr-1 and mgr-2, the sentinels on mgr-1, mgr-2 and wkr-1.
 */

const MB = 1024 * 1024;

/** Where each seeded member's copies run, in order (the first `running` are used). */
const PLACED: Record<string, string[]> = {
  'storefront_checkout-primary': ['n-wkr-1'],
  'storefront_checkout-replica': ['n-mgr-2', 'n-wkr-2'],
  'data_main-primary': ['n-wkr-2'],
  'data_main-replica': ['n-wkr-1', 'n-mgr-1'],
  'platform_metrics-primary': ['n-mgr-2'],
  'storefront_main-cache': ['n-wkr-2'],
  'storefront_main-cache-replica': ['n-wkr-1', 'n-mgr-2'],
  'storefront_main-cache-sentinel': ['n-mgr-1', 'n-mgr-2', 'n-wkr-1'],
  'platform_sessions-cache': ['n-mgr-2'],
  'storefront_main-search': ['n-wkr-1'],
};

interface Member {
  name: string;
  stack: string;
  image: string;
  status: string;
  desired: number;
  running: number;
}

interface DbTopo {
  stack: string;
  members: Array<{ service: string; status: string; desired: number; running: number }>;
}

function members(s: DemoStore): Member[] {
  const extra = s.extra as {
    data?: { dbTopologies?: DbTopo[] };
    cache?: { clusters?: CacheClusterView[] };
    searchsvc?: { instances?: SearchInstanceView[] };
  };
  const out: Member[] = [];
  for (const t of extra.data?.dbTopologies ?? []) {
    for (const m of t.members) out.push({ name: m.service, stack: t.stack, image: 'pgvector/pgvector:pg17', status: m.status, desired: m.desired, running: m.running });
  }
  for (const c of extra.cache?.clusters ?? []) {
    const image = c.engine === 'redis' ? 'redis:7.4' : 'valkey/valkey:8';
    for (const m of c.members) out.push({ name: m.service, stack: c.stack, image, status: m.status, desired: m.desired, running: m.running });
  }
  for (const i of extra.searchsvc?.instances ?? []) {
    out.push({ name: i.service, stack: i.stack, image: i.engine === 'typesense' ? 'typesense/typesense:27.1' : 'getmeili/meilisearch:v1.10', status: i.status, desired: i.desired, running: i.running });
  }
  return out;
}

/** The servers a member's running copies are on (seeded, else spread like `runsOn`). */
function serversOf(m: Member, nodes: NodeSummary[]): string[] {
  const placed = PLACED[m.name];
  if (placed) return placed.slice(0, m.running);
  const online = nodes.filter((n) => n.status === 'online');
  if (online.length === 0) return [];
  let h = 0;
  for (const c of m.name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return Array.from({ length: Math.min(m.running, online.length) }, (_, k) => online[(h + k) % online.length]!.id);
}

function summary(m: Member): ServiceSummary {
  const status = m.status === 'failing' ? 'failed' : m.status === 'idle' ? 'stopped' : m.status;
  return {
    id: m.name,
    name: m.name,
    image: m.image,
    status: status as ServiceSummary['status'],
    replicas: { desired: m.desired, running: m.running },
    ingressEnabled: false,
    nodeId: null,
    stackId: m.stack,
    updatedAt: new Date().toISOString(),
  };
}

/** The managed members a name-scoped `services.list` finds (and, with `nodeId`, those with a copy there). */
export function managedMembersMatching(s: DemoStore, f: { nodeId?: string; search?: string; stackId?: string }): ServiceSummary[] {
  if (!f.search) return [];
  const nodes = s.nodes as NodeSummary[];
  return members(s)
    .filter((m) => m.name.includes(f.search!) && (!f.stackId || m.stack === f.stackId))
    .filter((m) => !f.nodeId || serversOf(m, nodes).includes(f.nodeId))
    .map(summary);
}

/** The servers a managed member's running copies are on, by service name ([] when it isn't one). */
export function managedMemberServers(s: DemoStore, service: string): string[] {
  const m = members(s).find((x) => x.name === service);
  return m ? serversOf(m, s.nodes as NodeSummary[]) : [];
}

/** `services.usage` for a managed member, by service name (null when nothing runs). */
export function managedMemberUsage(s: DemoStore, id: string): ServiceUsageView | null | undefined {
  const m = members(s).find((x) => x.name === id);
  if (!m) return undefined;
  if (m.running === 0) return null;
  const base = /-primary$/.test(m.name) ? 612 * MB : /-replica$/.test(m.name) ? 540 * MB : /-search$/.test(m.name) ? 380 * MB : 96 * MB;
  const mem = Math.round(base * (0.97 + Math.random() * 0.06));
  return { sampled: m.running, cpuCores: { avg: 0.18, peak: 0.24 }, memBytes: { avg: Math.round(mem * 0.95), peak: mem }, ts: Date.now() };
}
