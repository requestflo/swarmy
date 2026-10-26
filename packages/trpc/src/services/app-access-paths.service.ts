/**
 * Per-path who-can-enter for a protected app (board 65): "/admin/* → group
 * admins only; everything else → anyone the app admits". Stored with the
 * route's `access` object on its `swarmy.ingress.routes` label (Docker truth,
 * no secrets), judged by `@swarmy/core` app-access-paths at the edge check.
 * Rules only narrow the app's who-can-enter; they never widen it.
 */
import { TRPCError } from '@trpc/server';
import { parseAppPathRules, ruleKey, type AppPathRule } from '@swarmy/core';
import type { OrgContext } from '../context';
import { notFound } from '../errors';
import { writeAudit } from './audit.service';
import { listRoutesForOrg, type Route } from './ingress-routes';
import { setServiceRoutes } from './ingress-routes-api';
import { getAppAccess, routeId, type AppAccessView } from './app-access-admin.service';

const uniq = (xs: string[] | undefined): string[] | undefined => {
  const out = [...new Set((xs ?? []).map((x) => x.trim()).filter(Boolean))].sort();
  return out.length ? out : undefined;
};

/** One rule in its stored form: a canonical path, only the who-fields that say something. */
export function compactPathRule(r: AppPathRule): AppPathRule {
  const key = ruleKey(r.path.trim());
  const path = key === null ? r.path : key === '/' ? '/' : `${key}/*`;
  const roles = uniq(r.roles) as AppPathRule['roles'];
  const groups = uniq(r.groups);
  const people = uniq(r.people);
  return {
    path,
    ...(r.everyone ? { everyone: true } : {}),
    ...(roles ? { roles } : {}),
    ...(groups ? { groups } : {}),
    ...(people ? { people } : {}),
  };
}

/**
 * PURE: a service's whole route set with one route's path rules replaced
 * (the label holds every route, so it is rewritten whole). Everything else on
 * the route — and every other route — is kept as it is.
 */
export function withPathRules(routes: readonly Route[], target: Route, rules: AppPathRule[]): Route[] {
  return routes.map((route) => {
    if (route !== target) return route;
    const { paths: _drop, ...access } = route.access ?? { login: true as const };
    return { ...route, access: { ...access, login: true as const, ...(rules.length ? { paths: rules } : {}) } };
  });
}

/** Replace one protected route's path rules (an empty list removes them). */
export async function setAppPathRules(
  ctx: OrgContext,
  input: { stack: string; routeId: string; rules: AppPathRule[] },
): Promise<AppAccessView> {
  const all = listRoutesForOrg(ctx);
  const hit = all.find((r) => r.stack === input.stack && routeId(r.serviceId, r.route.host, r.route.path) === input.routeId);
  if (!hit) throw notFound('app address', input.routeId);
  if (hit.route.access?.login !== true) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Ask people to sign in on this address first; path rules narrow who gets in after sign-in.' });
  }
  const rules = input.rules.map(compactPathRule);
  if (parseAppPathRules(rules) === null) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Each rule needs its own path, like /admin or /admin/*, with no ?, #, %, .. or //.' });
  }
  const own = all.filter((r) => r.serviceId === hit.serviceId).map((r) => r.route);
  await setServiceRoutes(ctx, hit.serviceId, withPathRules(own, hit.route, rules));
  await writeAudit(ctx, {
    action: 'app.access.pathRules.set',
    targetType: 'stack',
    targetId: input.stack,
    metadata: { host: hit.route.host, path: hit.route.path ?? '/', rules },
  });
  return getAppAccess(ctx, input.stack);
}
