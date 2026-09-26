import type { ServiceDetail } from '@swarmy/core';
import { findAppTemplate, loadTemplate, primaryService } from '@swarmy/templates';
import type { DemoStore } from '../types';
import { seedDemoRoute } from './ingress';

/**
 * A demo deploy that comes alive over ~15 s, so the app page's "Deploying →
 * It's live" tracker ticks in demo mode like it does against a controller.
 * `blueprints.deploy` seeds the new app's services (and its automatic
 * address); `advanceDemoDeploys` runs before every demo read (demo-link) and
 * moves each one along by wall-clock time:
 *   pending (no task yet: pulling)  →  deploying (container starting)  →  running
 * Data services start first; the route's certificate is "issuing" until
 * shortly after the main service is up. Every reader (inventory, services,
 * stacks, domains) sees the same store, so they agree.
 */

export const DATA_START = 2_500;
export const DATA_READY = 6_000;
export const MAIN_START = 4_500;
export const MAIN_READY = 10_000;
export const CERT_READY = 13_000;

interface DemoDeploy {
  stackId: string;
  at: number;
  /** service id → is it the main (routed) service. */
  services: Record<string, boolean>;
  done: boolean;
}

const deploys = (s: DemoStore): DemoDeploy[] => ((s.extra.demoDeploys ??= []) as DemoDeploy[]);

export interface DemoDeployPart {
  name: string;
  image: string;
  port?: number;
  main: boolean;
}

/** Seed a fresh app's services (0/1, nothing pulled yet) and remember when it went out. */
export function seedDemoDeploy(s: DemoStore, stackId: string, parts: DemoDeployPart[]): ServiceDetail[] {
  const now = new Date().toISOString();
  const rid = (): string => Math.random().toString(36).slice(2, 7);
  const made = parts.map<ServiceDetail>((p) => ({
    id: `svc-${p.name}-${rid()}`,
    name: p.name,
    image: p.image,
    status: 'pending',
    replicas: { desired: 1, running: 0 },
    ingressEnabled: p.main && p.port !== undefined,
    nodeId: 'n-wkr-1',
    stackId,
    updatedAt: now,
    env: {},
    ports: p.port ? [{ target: p.port, protocol: 'tcp', mode: 'ingress' }] : [],
    volumes: [],
    networks: [`${stackId}_net`],
    constraints: [],
    swarmServiceId: null,
    createdAt: now,
  }));
  s.services.push(...made);
  deploys(s).push({
    stackId,
    at: Date.now(),
    services: Object.fromEntries(made.map((m, i) => [m.id, parts[i]!.main])),
    done: false,
  });
  return made;
}

/** Move every in-flight demo deploy along by elapsed time (idempotent). */
export function advanceDemoDeploys(s: DemoStore): void {
  const list = s.extra.demoDeploys as DemoDeploy[] | undefined;
  if (!list?.length) return;
  const now = Date.now();
  for (const d of list) {
    if (d.done) continue;
    const t = now - d.at;
    for (const [id, main] of Object.entries(d.services)) {
      const sv = s.services.find((x) => x.id === id);
      if (!sv) continue;
      const start = main ? MAIN_START : DATA_START;
      const ready = main ? MAIN_READY : DATA_READY;
      sv.status = t >= ready ? 'running' : t >= start ? 'deploying' : 'pending';
      sv.replicas = { desired: 1, running: t >= ready ? 1 : 0 };
    }
    const st = s.stacks.find((x) => x.id === d.stackId);
    if (st) st.status = t >= MAIN_READY ? 'running' : 'deploying';
    if (t >= CERT_READY) d.done = true;
  }
}

// ── What a blueprint deploy creates in the demo world ─────────────────────────

const BUILTIN_IMAGES: Record<string, string> = {
  db: 'mariadb:11.4',
  wordpress: 'wordpress:6.6-apache',
  n8n: 'n8nio/n8n:1.64.0',
  directus: 'directus/directus:11.1',
  search: 'getmeili/meilisearch:v1.10',
  site: 'nginx:1.27-alpine',
};

/** The parts a deploy creates: a catalogue app's swarmy.yaml services, else the plan's service list. */
export function demoDeployParts(
  templateId: string,
  stack: string,
  options: Record<string, unknown> | undefined,
  planServices: string[],
  routed: { service: string; port: number } | null,
): DemoDeployPart[] {
  const t = findAppTemplate(templateId);
  const desired = t ? loadTemplate(t, { stack, options: options as never }).desired : undefined;
  if (t && desired) {
    const mainName = routed?.service ?? primaryService(t, desired)?.name;
    return desired.services.map((sv) => ({
      name: sv.name,
      image: sv.source.kind === 'image' ? sv.source.image : `registry.local/${stack}/${sv.name}:latest`,
      port: sv.port,
      main: sv.name === mainName,
    }));
  }
  const image = typeof options?.image === 'string' && options.image ? options.image : null;
  const names = planServices.length ? planServices : ['app'];
  const mainName = routed?.service ?? names[names.length - 1]!;
  return names.map((name) => ({
    name,
    image: BUILTIN_IMAGES[name] ?? image ?? `ghcr.io/acme/${name}:latest`,
    port: name === mainName ? routed?.port ?? 80 : undefined,
    main: name === mainName,
  }));
}

/** Seed the app's services and give the main one an address (the domain asked for, else an automatic sslip.io one). */
export function landDemoDeploy(
  s: DemoStore,
  x: { stackId: string; stack: string; parts: DemoDeployPart[]; domain?: string; exposed: boolean },
): string | null {
  if (!x.parts.some((p) => p.main) && x.parts[0]) x.parts[0].main = true;
  const made = seedDemoDeploy(s, x.stackId, x.parts);
  const i = x.parts.findIndex((p) => p.main);
  const main = made[i];
  const part = x.parts[i];
  if (!main || !part || !x.exposed || part.port === undefined) return null;
  const label = `${part.name}-${x.stack}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const host = x.domain ?? `${label}.203-0-113-10.sslip.io`;
  seedDemoRoute(s, {
    host,
    serviceId: main.id,
    serviceName: main.name,
    stack: x.stack,
    port: part.port,
    auto: !x.domain,
    issuingUntil: Date.now() + CERT_READY,
  });
  return host;
}
