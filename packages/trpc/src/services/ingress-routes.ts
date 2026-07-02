/**
 * Per-service ingress routing — read from / written to the single Docker service
 * label `swarmy.ingress.routes` (JSON array). Docker is the source of truth: a
 * service's routes live on the live hub inventory's service labels, never the DB.
 *
 * A service with no such label exposes nothing; an empty array is equivalent and
 * its writers remove the label entirely (see ingress.service `removeDomain`).
 */
import { buildInventory } from '@swarmy/core';
import type { OrgContext } from '../context';

/** The one label that carries a service's ingress routes (JSON-string array). */
export const INGRESS_ROUTES_LABEL = 'swarmy.ingress.routes';

/**
 * Weighted canary upstream for a route (slice D2). When present, the render
 * layer emits BOTH upstreams with `lb_policy weighted_round_robin` so
 * `weightPct` percent of the host's traffic reaches `service:port` (the
 * canary) and the rest stays on the stable upstream.
 */
export interface RouteCanary {
  /** Canary Docker service name (e.g. `storefront_web--canary`). */
  service: string;
  port: number;
  /** Share of traffic (0–100) sent to the canary upstream. */
  weightPct: number;
}

/**
 * One ingress route. `tls: 'manual'` means an operator-supplied certificate
 * (the render layer's equivalent is `'custom'`); `'auto'` = ACME, `'off'` = none.
 */
export interface Route {
  host: string;
  port: number;
  tls: 'auto' | 'off' | 'manual';
  path?: string;
  stripPrefix?: boolean;
  middlewares?: string[];
  driver?: string;
  /** Weighted canary upstream (slice D2); absent = 100% stable. */
  canary?: RouteCanary;
}

/** A route together with the live Docker service carrying it. */
export interface ServiceRoute {
  serviceId: string;
  serviceName: string;
  route: Route;
}

const TLS_VALUES = new Set<Route['tls']>(['auto', 'off', 'manual']);

/** Coerce one parsed array element into a {@link Route}, or drop it if unusable. */
function coerceRoute(value: unknown): Route | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.host !== 'string' || v.host.length === 0) return undefined;
  if (typeof v.port !== 'number' || !Number.isFinite(v.port)) return undefined;
  const tls = typeof v.tls === 'string' && TLS_VALUES.has(v.tls as Route['tls'])
    ? (v.tls as Route['tls'])
    : 'auto';
  const route: Route = { host: v.host, port: v.port, tls };
  if (typeof v.path === 'string') route.path = v.path;
  if (typeof v.stripPrefix === 'boolean') route.stripPrefix = v.stripPrefix;
  if (Array.isArray(v.middlewares)) {
    route.middlewares = v.middlewares.filter((m): m is string => typeof m === 'string');
  }
  if (typeof v.driver === 'string') route.driver = v.driver;
  const canary = coerceCanary(v.canary);
  if (canary) route.canary = canary;
  return route;
}

/** Coerce a route's `canary` fragment, or drop it if unusable (tolerant). */
function coerceCanary(value: unknown): RouteCanary | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.service !== 'string' || v.service.length === 0) return undefined;
  if (typeof v.port !== 'number' || !Number.isFinite(v.port)) return undefined;
  if (typeof v.weightPct !== 'number' || !Number.isFinite(v.weightPct)) return undefined;
  return {
    service: v.service,
    port: v.port,
    weightPct: Math.min(100, Math.max(0, v.weightPct)),
  };
}

/**
 * Parse the `swarmy.ingress.routes` label into routes. Tolerant by design: a
 * missing label, malformed JSON, a non-array payload, or unusable entries all
 * collapse to `[]` (bad entries are dropped) — a malformed label never throws.
 */
export function readRoutes(labels: Record<string, string>): Route[] {
  const raw = labels[INGRESS_ROUTES_LABEL];
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: Route[] = [];
  for (const entry of parsed) {
    const route = coerceRoute(entry);
    if (route) out.push(route);
  }
  return out;
}

/** Serialize routes back into the label's JSON-string value. */
export function serializeRoutes(routes: Route[]): string {
  return JSON.stringify(routes);
}

/**
 * Every ingress route across the org, read live from Docker service labels
 * (`ctx.hub.liveInventory` → `buildInventory`). No DB: a route's owning service
 * is the live service carrying the `swarmy.ingress.routes` label.
 */
export function listRoutesForOrg(ctx: OrgContext): ServiceRoute[] {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  const out: ServiceRoute[] = [];
  for (const s of buildInventory(services, containers).services) {
    for (const route of readRoutes(s.labels)) {
      out.push({ serviceId: s.id, serviceName: s.name, route });
    }
  }
  return out;
}
