/**
 * PURE — "how do I reach this from inside the cluster?" for one app (stack):
 * the internal DNS names swarm resolves for each service and managed resource,
 * and WHO can use each name. Feeds the UI line "reach this at `db:5432` from
 * inside storefront". Derived entirely from live Docker truth (labels +
 * networks), so it is exactly what the swarm's embedded DNS will answer.
 *
 * Names (Docker Swarm DNS, VIP mode unless a service opts into dnsrr):
 *   <short>            — the compose short name; resolves ONLY inside the app
 *                        (`<app>_default` alias). What app code should use.
 *   <app>_<short>      — the swarm service name; resolves on every network the
 *                        service is on (same app, connected apps, the edge).
 *   tasks.<short>      — every task IP (client-side load balancing / peers).
 *   <short>.<app>      — from a CONNECTED app (pair overlay alias).
 *   managed resources  — their service name, from the app services attached
 *                        to them (the injected DATABASE_URL etc. already use it).
 *   swarmy-garage:3900 — S3 object storage, from bucket-attached services.
 */
import { LINKS_LABEL, linkAlias, parseLinksLabel, type InvService } from '@swarmy/core';
import { readRoutes } from './ingress-routes';
import { isLinkableService, shortName } from './stack-links.service';

export type EndpointScope = 'app' | 'connected' | 'attached';

export interface EndpointName {
  host: string;
  port?: number;
  /** Who can resolve it: services of this app / of a connected app / attached app services. */
  scope: EndpointScope;
  /** For `connected`: the peer apps; for `attached`: the app services wired to it. */
  from?: string[];
}

export interface ServiceEndpoints {
  service: string;
  short: string;
  /** Container ports swarmy knows about (routes + published targets). */
  ports: number[];
  names: EndpointName[];
}

export type ResourceKind = 'postgres' | 'cache' | 'search' | 'vector' | 'object-storage';

export interface ResourceEndpoint {
  kind: ResourceKind;
  /** Resource name (cluster / instance / bucket). */
  name: string;
  host: string;
  port: number;
  /** e.g. `primary` / `replica` / `sentinel`. */
  role?: string;
  /** App services of this stack wired to it (they alone share its network). */
  attached: string[];
}

export interface StackEndpoints {
  stack: string;
  /** Apps this one is connected to ("connect apps"). */
  connectedApps: string[];
  services: ServiceEndpoints[];
  resources: ResourceEndpoint[];
}

const SEARCH_PORTS: Record<string, number> = { meilisearch: 7700, typesense: 8108 };

function portsOf(s: InvService): number[] {
  const out = new Set<number>();
  for (const r of readRoutes(s.labels)) if (r.port) out.add(r.port);
  for (const p of s.ports) if (p.target) out.add(p.target);
  return [...out].sort((a, b) => a - b);
}

function resourceOf(s: InvService): Omit<ResourceEndpoint, 'attached' | 'host'> | null {
  const l = s.labels;
  if (l['swarmy.db.cluster']) {
    if (l['swarmy.db.role'] === 'etcd') return null;
    return { kind: 'postgres', name: l['swarmy.db.cluster'], port: 5432, role: l['swarmy.db.role'] };
  }
  if (l['swarmy.cache.cluster']) {
    const role = l['swarmy.cache.role'];
    return { kind: 'cache', name: l['swarmy.cache.cluster'], port: role === 'sentinel' ? 26379 : 6379, role };
  }
  if (l['swarmy.search.engine']) {
    const name = l['swarmy.search.cluster'] ?? s.name;
    return { kind: 'search', name, port: SEARCH_PORTS[l['swarmy.search.engine']] ?? 7700 };
  }
  if (l['swarmy.vector.name']) return { kind: 'vector', name: l['swarmy.vector.name'], port: 6333 };
  return null;
}

const INJECT_LABEL: Record<Exclude<ResourceKind, 'object-storage'>, string> = {
  postgres: 'swarmy.db.inject',
  cache: 'swarmy.cache.inject',
  search: 'swarmy.search.inject',
  vector: 'swarmy.vector.inject',
};

/** Endpoints for one stack from its live services. Pure. */
export function stackEndpoints(stack: string, services: readonly InvService[]): StackEndpoints {
  const mine = services.filter((s) => s.stack === stack);
  const apps = mine.filter(isLinkableService);
  const connectedApps = [...new Set(apps.flatMap((s) => parseLinksLabel(s.labels[LINKS_LABEL])))].sort();

  const out: ServiceEndpoints[] = apps.map((s) => {
    const short = shortName(stack, s.name);
    const ports = portsOf(s);
    const port = ports.length === 1 ? ports[0] : undefined;
    const inApp = s.networks.some((n) => n.aliases.includes(short));
    const names: EndpointName[] = [];
    if (inApp) names.push({ host: short, port, scope: 'app' });
    names.push({ host: s.name, port, scope: 'app' });
    names.push({ host: `tasks.${inApp ? short : s.name}`, port, scope: 'app' });
    const peers = parseLinksLabel(s.labels[LINKS_LABEL]);
    if (peers.length) names.push({ host: linkAlias(stack, short), port, scope: 'connected', from: peers });
    return { service: s.name, short, ports, names };
  });

  const resources: ResourceEndpoint[] = [];
  for (const s of mine) {
    const r = resourceOf(s);
    if (!r) continue;
    const inject = INJECT_LABEL[r.kind as Exclude<ResourceKind, 'object-storage'>];
    const attached = apps.filter((a) => a.labels[inject] === r.name).map((a) => a.name);
    resources.push({ ...r, host: s.name, attached });
  }
  const bucketApps = apps.filter((a) => a.labels['swarmy.s3.bucket']);
  for (const bucket of [...new Set(bucketApps.map((a) => a.labels['swarmy.s3.bucket']!))].sort()) {
    resources.push({
      kind: 'object-storage',
      name: bucket,
      host: 'swarmy-garage',
      port: 3900,
      attached: bucketApps.filter((a) => a.labels['swarmy.s3.bucket'] === bucket).map((a) => a.name),
    });
  }
  resources.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.host.localeCompare(b.host));
  return { stack, connectedApps, services: out, resources };
}
