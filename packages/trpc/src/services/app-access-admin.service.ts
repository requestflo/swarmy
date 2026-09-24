/**
 * The app Access panel's service (dev-platform §2): the "Require login"
 * toggle, "who can enter" rules, and — for apps with `auth:` in swarmy.yaml —
 * the app's own end users.
 *
 * Where things live (docker-native):
 *   - Require login  → `access.login` on the route's `swarmy.ingress.routes` label;
 *   - Who can enter  → ordinary ABAC policies for `app.access` on the stack,
 *                      one per kind (everyone / groups / people — a single
 *                      policy would AND groups with members), written through
 *                      the policies service so defaults stay managed;
 *   - End users      → the app's own auth service database, reached over its
 *                      admin API with a 60s controller-signed JWT.
 */
import { TRPCError } from '@trpc/server';
import { parsePolicyDoc } from '@swarmy/abac';
import type { OrgContext } from '../context';
import { notFound } from '../errors';
import { whoCan } from '../abac';
import { writeAudit } from './audit.service';
import { listRoutesForOrg, type Route } from './ingress-routes';
import { setServiceRoutes } from './ingress-routes-api';
import { deletePolicy, listPolicies, setPolicy } from './policies.service';
import { appResource } from './app-access.service';
import { signAdminJwt } from './app-access-tokens';

export const APP_RULE_PREFIX = 'App access · ';
const RULE_KINDS = ['everyone', 'groups', 'people'] as const;
type RuleKind = (typeof RULE_KINDS)[number];

export interface AppAccessRouteView {
  id: string;
  serviceId: string;
  serviceName: string;
  host: string;
  path: string;
  requireLogin: boolean;
  /** The app's own `auth:` service route (never login-gated). */
  endUserAuth: boolean;
}

export interface AppAccessRules {
  everyone: boolean;
  groups: string[];
  /** Member ids. */
  people: string[];
}

export interface AppAccessPerson {
  memberId: string;
  name: string | null;
  email: string | null;
  role: string;
  groups: string[];
  canEnter: boolean;
}

export interface EndUserAuthView {
  serviceName: string;
  running: boolean;
  providers: string[];
  email: string;
  allowedDomains: string[];
  database: 'sqlite' | 'postgres';
  /** Docker secrets each provider reads, and the redirect URI to register with it. */
  providerSetup: { provider: string; secrets: string[]; callbackUrl: string | null }[];
}

export interface AppAccessView {
  stack: string;
  routes: AppAccessRouteView[];
  rules: AppAccessRules;
  people: AppAccessPerson[];
  knownGroups: string[];
  endUserAuth: EndUserAuthView | null;
}

const AUTH_UNIT = 'swarmy-auth';
const routeId = (serviceId: string, host: string, path?: string) => `${serviceId}|${host}|${path ?? ''}`;

function ruleName(stack: string, kind: RuleKind): string {
  return `${APP_RULE_PREFIX}${stack} · ${kind}`;
}

function ruleSource(stack: string, kind: RuleKind, values: string[]): string {
  return JSON.stringify({
    actions: ['app.access'],
    resourceTypes: ['stack', 'service'],
    ...(kind === 'everyone' ? { roles: ['owner', 'admin', 'member'] } : kind === 'groups' ? { groups: values } : { members: values }),
    conditions: [{ attr: 'resource.id', op: 'eq', value: stack }],
  });
}

function stackRoutes(ctx: OrgContext, stack: string) {
  return listRoutesForOrg(ctx).filter((r) => r.stack === stack);
}

function envOf(env: readonly string[], key: string): string {
  const hit = env.find((e) => e.startsWith(`${key}=`));
  return hit ? hit.slice(key.length + 1) : '';
}

function endUserAuthFor(ctx: OrgContext, stack: string, appHost: string | null): EndUserAuthView | null {
  const { services } = ctx.hub.liveInventory(ctx.activeOrgId);
  const svc = services.find((s) => s.name === `${stack}_${AUTH_UNIT}`);
  if (!svc) return null;
  const providers = envOf(svc.env, 'AUTH_PROVIDERS').split(',').filter(Boolean);
  const base = appHost ? `https://${appHost}/auth` : null;
  return {
    serviceName: svc.name,
    running: svc.runningReplicas > 0,
    providers,
    email: envOf(svc.env, 'AUTH_EMAIL') || 'magic-link',
    allowedDomains: envOf(svc.env, 'AUTH_ALLOWED_DOMAINS').split(',').filter(Boolean),
    database: envOf(svc.env, 'AUTH_SQLITE_PATH') ? 'sqlite' : 'postgres',
    providerSetup: providers.map((p) => ({
      provider: p,
      secrets: [`auth-${p}-client-id`, `auth-${p}-client-secret`],
      callbackUrl: base ? (p === 'oidc' ? `${base}/oauth2/callback/oidc` : `${base}/callback/${p}`) : null,
    })),
  };
}

async function readRules(ctx: OrgContext, stack: string): Promise<{ rules: AppAccessRules; ids: Partial<Record<RuleKind, string>> }> {
  const rules: AppAccessRules = { everyone: false, groups: [], people: [] };
  const ids: Partial<Record<RuleKind, string>> = {};
  for (const p of await listPolicies(ctx)) {
    for (const kind of RULE_KINDS) {
      if (p.name !== ruleName(stack, kind) || p.isDefault) continue;
      ids[kind] = p.id;
      if (!p.enabled) continue;
      let doc;
      try {
        doc = parsePolicyDoc(p.source);
      } catch {
        continue;
      }
      if (kind === 'everyone') rules.everyone = true;
      if (kind === 'groups') rules.groups = [...(doc.groups ?? [])];
      if (kind === 'people') rules.people = [...(doc.members ?? [])];
    }
  }
  return { rules, ids };
}

export async function getAppAccess(ctx: OrgContext, stack: string): Promise<AppAccessView> {
  const routes = stackRoutes(ctx, stack);
  const routeViews: AppAccessRouteView[] = routes.map(({ serviceId, serviceName, route }) => ({
    id: routeId(serviceId, route.host, route.path),
    serviceId,
    serviceName,
    host: route.host,
    path: route.path ?? '/',
    requireLogin: route.access?.login === true,
    endUserAuth: serviceName.endsWith(`_${AUTH_UNIT}`),
  }));
  const { rules } = await readRules(ctx, stack);
  const first = routes.find((r) => !r.serviceName.endsWith(`_${AUTH_UNIT}`)) ?? routes[0];
  const resource = first
    ? appResource(ctx.hub, { orgId: ctx.activeOrgId, host: first.route.host, path: '/', serviceName: first.serviceName, stack })
    : { type: 'stack', id: stack, orgId: ctx.activeOrgId, labels: {} };
  const rows = await whoCan(ctx.db, ctx.activeOrgId, 'app.access', resource);
  const people: AppAccessPerson[] = rows.map((r) => ({
    memberId: r.memberId,
    name: r.name,
    email: r.email && !/\.swarmy\.invalid$/i.test(r.email) ? r.email : null,
    role: r.role,
    groups: r.groups,
    canEnter: r.decision === 'permit',
  }));
  const knownGroups = [...new Set(people.flatMap((p) => p.groups).concat(rules.groups))].sort();
  return {
    stack,
    routes: routeViews,
    rules,
    people,
    knownGroups,
    endUserAuth: endUserAuthFor(ctx, stack, first?.route.host ?? null),
  };
}

/** Turn "Require login" on/off for every route of the app (or the listed ones). */
export async function setRequireLogin(
  ctx: OrgContext,
  input: { stack: string; on: boolean; routeIds?: string[] },
): Promise<AppAccessView> {
  const routes = stackRoutes(ctx, input.stack);
  if (routes.length === 0) throw notFound('app routes', input.stack);
  const wanted = input.routeIds ? new Set(input.routeIds) : null;
  const byService = new Map<string, { serviceId: string; routes: Route[]; changed: boolean }>();
  for (const { serviceId, serviceName, route } of routes) {
    const entry = byService.get(serviceId) ?? { serviceId, routes: [], changed: false };
    // The app's own /auth service must stay reachable, or nobody could sign in.
    const target = !serviceName.endsWith(`_${AUTH_UNIT}`) && (!wanted || wanted.has(routeId(serviceId, route.host, route.path)));
    const { access: _drop, ...rest } = route;
    const next: Route = target ? (input.on ? { ...rest, access: { login: true } } : { ...rest, access: undefined }) : route;
    if (target && (route.access?.login === true) !== input.on) entry.changed = true;
    entry.routes.push(next);
    byService.set(serviceId, entry);
  }
  // The label holds a service's whole route set, so each touched service is rewritten whole.
  for (const e of byService.values()) {
    if (e.changed) await setServiceRoutes(ctx, e.serviceId, e.routes);
  }
  await writeAudit(ctx, {
    action: 'app.access.requireLogin',
    targetType: 'stack',
    targetId: input.stack,
    metadata: { on: input.on, routes: input.routeIds ?? 'all' },
  });
  return getAppAccess(ctx, input.stack);
}

/** Replace who may enter the app: everyone in the org, and/or groups, and/or named people. */
export async function setAppAccessRules(ctx: OrgContext, input: { stack: string } & AppAccessRules): Promise<AppAccessView> {
  const { ids } = await readRules(ctx, input.stack);
  const want: Record<RuleKind, string[] | null> = {
    everyone: input.everyone ? [] : null,
    groups: input.groups.length ? [...new Set(input.groups)].sort() : null,
    people: input.people.length ? [...new Set(input.people)].sort() : null,
  };
  for (const kind of RULE_KINDS) {
    const values = want[kind];
    const id = ids[kind];
    if (values === null) {
      if (id) await deletePolicy(ctx, id);
      continue;
    }
    await setPolicy(ctx, {
      ...(id ? { id } : {}),
      name: ruleName(input.stack, kind),
      description: `Who may sign in to ${input.stack} (written by the app's Access panel).`,
      effect: 'permit',
      priority: 30,
      enabled: true,
      source: ruleSource(input.stack, kind, values),
    });
  }
  return getAppAccess(ctx, input.stack);
}

// ── end users (auth: in swarmy.yaml) ─────────────────────────────────────────

export interface EndUser {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  emailVerified: boolean;
  disabled: boolean;
}

function controllerIssuer(): string {
  return (process.env.CONTROLLER_PUBLIC_URL ?? 'http://localhost:3021').replace(/\/+$/, '');
}

/** Call the app's auth service admin API: in-swarm first, then via its public /auth route. */
async function adminCall(ctx: OrgContext, stack: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const view = endUserAuthFor(ctx, stack, null);
  if (!view) throw new TRPCError({ code: 'NOT_FOUND', message: `${stack} has no auth: service` });
  const token = signAdminJwt({ iss: controllerIssuer(), sub: ctx.user.id, stack, org: ctx.activeOrgId });
  const host = stackRoutes(ctx, stack).find((r) => r.serviceName === view.serviceName)?.route.host;
  const bases = [`http://${view.serviceName}:3000`, ...(host ? [`https://${host}`] : [])];
  let last: unknown;
  for (const base of bases) {
    try {
      const res = await fetch(`${base}/auth/swarmy/admin${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new TRPCError({ code: res.status === 404 ? 'NOT_FOUND' : 'BAD_GATEWAY', message: `auth service answered ${res.status}` });
      return await res.json();
    } catch (e) {
      last = e;
      if (e instanceof TRPCError && e.code === 'NOT_FOUND') throw e;
    }
  }
  throw last instanceof TRPCError
    ? last
    : new TRPCError({ code: 'BAD_GATEWAY', message: `could not reach ${stack}'s auth service` });
}

export async function listEndUsers(ctx: OrgContext, stack: string): Promise<{ total: number; users: EndUser[] }> {
  const body = (await adminCall(ctx, stack, '/users?limit=200')) as { total: number; users: EndUser[] };
  return { total: body.total, users: body.users };
}

export async function setEndUserDisabled(
  ctx: OrgContext,
  input: { stack: string; userId: string; disabled: boolean },
): Promise<{ id: string; disabled: boolean }> {
  const res = (await adminCall(ctx, input.stack, `/users/${encodeURIComponent(input.userId)}/${input.disabled ? 'disable' : 'enable'}`, {
    method: 'POST',
  })) as { id: string; disabled: boolean };
  await writeAudit(ctx, {
    action: input.disabled ? 'app.auth.user.disable' : 'app.auth.user.enable',
    targetType: 'stack',
    targetId: input.stack,
    metadata: { userId: input.userId },
  });
  return res;
}
