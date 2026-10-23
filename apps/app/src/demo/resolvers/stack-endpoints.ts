import type { BucketAttachmentView, CacheClusterView, SearchInstanceView, VectorInstanceView } from '@swarmy/core';
import type { DemoStore } from '../types';

/**
 * The demo's `stacks.endpoints`, derived from the rest of the demo world so
 * the Connections tab agrees with the Data tab: services from the demo
 * swarm, Postgres members from `data` (db.get topologies), caches / search /
 * vector instances / buckets with their attachments from their modules. Shape
 * mirrors `stackEndpoints` in packages/trpc/src/services/service-endpoints.ts.
 */

export interface LinksState {
  /** Connected pairs, `a<->b` with a < b. */
  pairs: string[];
  /** `stack/cluster` → swarm service names wired to that Postgres (`db.inject`). */
  dbAttached: Record<string, string[]>;
}

type Scope = 'app' | 'connected' | 'attached';
interface Name {
  host: string;
  port?: number;
  scope: Scope;
  from?: string[];
}
interface Resource {
  kind: 'postgres' | 'cache' | 'search' | 'vector' | 'object-storage';
  name: string;
  host: string;
  port: number;
  role?: string;
  attached: string[];
}

interface DbTopo {
  stack: string;
  cluster: string;
  members: Array<{ service: string; role: string }>;
}

export function peersOf(st: LinksState, stack: string): string[] {
  return st.pairs
    .map((p) => p.split('<->'))
    .filter((p) => p.includes(stack))
    .map(([a, b]) => (a === stack ? b! : a!))
    .sort();
}

export function demoServices(store: DemoStore, stack: string): Array<{ full: string; short: string; ports: number[] }> {
  const id = store.stacks.find((s) => s.name === stack)?.id;
  if (!id || stack === 'swarmy-system') return [];
  return store.services
    .filter((s) => s.stackId === id)
    .map((s) => ({ full: `${stack}_${s.name}`, short: s.name, ports: [...new Set(s.ports.map((p) => p.target))].sort((a, b) => a - b) }));
}

function resources(store: DemoStore, st: LinksState, stack: string): Resource[] {
  const full = (svc: string): string => (svc.startsWith(`${stack}_`) ? svc : `${stack}_${svc}`);
  const extra = store.extra as {
    data?: { dbTopologies?: DbTopo[] };
    cache?: { clusters?: CacheClusterView[] };
    searchsvc?: { instances?: SearchInstanceView[] };
    vector?: { instances?: VectorInstanceView[] };
    buckets?: { buckets?: Array<{ name: string; attachments: BucketAttachmentView[] }> };
  };
  const out: Resource[] = [];
  for (const t of (extra.data?.dbTopologies ?? []).filter((x) => x.stack === stack)) {
    const attached = st.dbAttached[`${stack}/${t.cluster}`] ?? [];
    for (const m of t.members.filter((x) => x.role !== 'dcs')) {
      out.push({ kind: 'postgres', name: t.cluster, host: m.service, port: 5432, role: m.role, attached });
    }
  }
  for (const c of (extra.cache?.clusters ?? []).filter((x) => x.stack === stack)) {
    const attached = c.attachments.map((a) => full(a.service));
    for (const m of c.members) {
      out.push({ kind: 'cache', name: c.name, host: m.service, port: m.role === 'sentinel' ? 26379 : 6379, role: m.role, attached });
    }
  }
  for (const i of (extra.searchsvc?.instances ?? []).filter((x) => x.stack === stack)) {
    out.push({ kind: 'search', name: i.name, host: i.host, port: i.port, attached: i.attachments.map((a) => full(a.service)) });
  }
  for (const v of (extra.vector?.instances ?? []).filter((x) => x.stack === stack)) {
    out.push({ kind: 'vector', name: v.name, host: v.host, port: v.port, attached: v.attachments.map((a) => full(a.service)) });
  }
  for (const b of extra.buckets?.buckets ?? []) {
    const attached = b.attachments.filter((a) => a.stack === stack).map((a) => full(a.service));
    if (attached.length) out.push({ kind: 'object-storage', name: b.name, host: 'swarmy-garage', port: 3900, attached });
  }
  return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.host.localeCompare(b.host));
}

export function demoEndpoints(store: DemoStore, st: LinksState, stack: string) {
  if (!store.stacks.some((s) => s.name === stack)) throw new Error(`stack "${stack}" not found`);
  const peers = peersOf(st, stack);
  const services = demoServices(store, stack).map((s) => {
    const port = s.ports.length === 1 ? s.ports[0] : undefined;
    const names: Name[] = [
      { host: s.short, port, scope: 'app' },
      { host: s.full, port, scope: 'app' },
      { host: `tasks.${s.short}`, port, scope: 'app' },
    ];
    if (peers.length) names.push({ host: `${s.short}.${stack}`, port, scope: 'connected', from: peers });
    return { service: s.full, short: s.short, ports: s.ports, names };
  });
  return { stack, connectedApps: peers, services, resources: resources(store, st, stack) };
}
