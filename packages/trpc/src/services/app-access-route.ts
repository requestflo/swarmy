/**
 * Which login-protected route a forward-auth request is for, and the ABAC
 * resource it is judged on (app-access.service.ts). Docker truth: routes are
 * read live from the `swarmy.ingress.routes` labels; nothing is stored.
 */
import { appPathReadings, buildInventory, UNGROUPED } from '@swarmy/core';
import type { ResourceInput } from '@swarmy/abac';
import { isBroadWildcard } from '@swarmy/ingress';
import type { OrgContext } from '../context';
import type { AgentHub } from '../hub/types';
import { liveStackLabels } from '../abac';
import { readRoutes, type RouteAccess } from './ingress-routes';

export interface ProtectedRoute {
  orgId: string;
  host: string;
  path: string;
  serviceName: string;
  /** Docker stack of the owning service ('' when standalone). */
  stack: string;
  /** The route's `access` object as the label carries it (path rules, sign-in method). */
  access?: RouteAccess;
}

/** The app a route belongs to, as audit rows and the ABAC resource name it. */
export function appTarget(route: Pick<ProtectedRoute, 'stack' | 'serviceName'>): { type: 'stack' | 'service'; id: string } {
  return route.stack ? { type: 'stack', id: route.stack } : { type: 'service', id: route.serviceName };
}

/**
 * A wildcard over a public suffix (`*.com`, `*.co.uk`) never matches: it
 * would let the login round trip mint a code for, and redirect it to, any
 * host under the suffix. Such a route fails closed (403 / 404).
 */
function hostMatches(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase();
  if (p.startsWith('*.')) return !isBroadWildcard(p) && host.endsWith(p.slice(1)) && host.length > p.length - 1;
  return p === host;
}

export function pathOf(uri: string): string {
  const q = uri.search(/[?#]/);
  return q >= 0 ? uri.slice(0, q) : uri;
}

/**
 * The login-protected route serving `host` + `path` in this org, from the live
 * `swarmy.ingress.routes` labels: longest matching prefix among the host's
 * protected routes, else any protected route on the host (the edge only asks
 * for protected routes). Null ⇒ nothing here is protected — callers fail closed.
 */
export function findProtectedRoute(
  hub: Pick<AgentHub, 'liveInventory'>,
  orgId: string,
  host: string,
  path = '/',
): ProtectedRoute | null {
  const { services, containers } = hub.liveInventory(orgId);
  const candidates: ProtectedRoute[] = [];
  for (const s of buildInventory(services, containers).services) {
    for (const r of readRoutes(s.labels)) {
      if (!r.access?.login || !hostMatches(r.host, host)) continue;
      candidates.push({
        orgId,
        host: r.host.toLowerCase(),
        path: r.path && r.path.length > 0 ? r.path : '/',
        serviceName: s.name,
        stack: s.stack && s.stack !== UNGROUPED ? s.stack : '',
        access: r.access,
      });
    }
  }
  if (candidates.length === 0) return null;
  // The path as the edge's route matcher reads it (decoded, cleaned, any case).
  const edge = appPathReadings(path)?.[0];
  const p = edge ? (path.endsWith('/') && edge !== '/' ? `${edge}/` : edge) : path.toLowerCase();
  const matching = candidates
    .filter((c) => c.path === '/' || p.startsWith(c.path.toLowerCase()))
    .sort((a, b) => b.path.length - a.path.length);
  return matching[0] ?? candidates[0]!;
}

/** The ABAC resource an app login is evaluated on: its stack (or the lone service). */
export function appResource(hub: Pick<AgentHub, 'liveInventory'>, route: ProtectedRoute): ResourceInput {
  if (route.stack) {
    const labels =
      liveStackLabels({ hub, activeOrgId: route.orgId } as unknown as OrgContext, route.stack) ?? {};
    return { type: 'stack', id: route.stack, orgId: route.orgId, labels };
  }
  const { services, containers } = hub.liveInventory(route.orgId);
  const svc = buildInventory(services, containers).services.find((s) => s.name === route.serviceName);
  return { type: 'service', id: route.serviceName, orgId: route.orgId, labels: svc?.labels ?? {} };
}
