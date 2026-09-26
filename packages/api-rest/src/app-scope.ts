/**
 * The app gate: the ONE place an app-scoped API key (`stackNames` set, owner
 * decision Q7) is held to its apps. It runs for every `/api/v1` resource
 * request right after `apiKeyAuth`, before any route middleware or handler,
 * and it is fail-closed: a route that is not listed in {@link APP_ROUTES} is
 * refused for an app-scoped key (so a new org-wide route can't leak).
 *
 * Per route it either
 *  - resolves the app the request targets BEFORE the handler runs, and answers
 *    404 when that app is outside the key's list (NOT_FOUND, never "forbidden",
 *    so a key can't probe which other apps exist);
 *  - filters an org-wide list down to the key's apps after the handler; or
 *  - checks a read's `stack` field after the handler (read-only routes whose
 *    app is only known from the result).
 *
 * Keys without an app list (and OAuth tokens) pass straight through. The key's
 * scopes and its creator's role still apply on top — this only narrows.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { keyReachesApp } from '@swarmy/core';
import { serviceStackName, stackNameForId, type OrgContext } from '@swarmy/trpc';
import type { RestEnv } from './middleware';
import { PROBLEM_CONTENT_TYPE, problem } from './problem';

type Params = Record<string, string>;

type AppRule =
  /** The request carries no app and touches none of another app's data. */
  | { kind: 'allow' }
  /** Resolve the target app before the handler; null = not an app's resource. */
  | { kind: 'target'; app: (ctx: OrgContext, params: Params, c: Context<RestEnv>) => Promise<string | null> }
  /** An org-wide list: keep only `data[]` items whose app the key reaches. */
  | { kind: 'filter'; app: (ctx: OrgContext, item: Record<string, unknown>) => string | null }
  /** A read whose app is in the response body. */
  | { kind: 'result'; app: (body: Record<string, unknown>) => string | null };

const stackParam: AppRule = { kind: 'target', app: (ctx, p) => stackNameForId(ctx, p.id ?? '') };
const serviceParam: AppRule = { kind: 'target', app: async (ctx, p) => serviceStackName(ctx, p.id ?? '') };

async function bodyField(c: Context<RestEnv>, field: string): Promise<string | null> {
  // Hono caches the parsed body, so the route's validator still sees it.
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const v = body?.[field];
  return typeof v === 'string' && v ? v : null;
}

/**
 * Every route an app-scoped key may use, as `METHOD /path/{param}`. Anything
 * else — servers, DNS, domains, backups, volumes, registry, git, API keys,
 * audit, notify — is org-wide and refused.
 */
export const APP_ROUTES: Record<string, AppRule> = {
  'GET /me': { kind: 'allow' },

  'GET /stacks': { kind: 'filter', app: (_ctx, s) => (typeof s.name === 'string' ? s.name : null) },
  'GET /stacks/{id}': stackParam,
  'POST /stacks': { kind: 'target', app: (_ctx, _p, c) => bodyField(c, 'name') },
  'DELETE /stacks/{id}': stackParam,
  'GET /stacks/{id}/telemetry': stackParam,
  'PUT /stacks/{id}/telemetry': stackParam,
  'GET /stacks/{id}/errors': stackParam,
  'POST /stacks/{id}/errors/rotate-key': stackParam,

  'GET /services': { kind: 'filter', app: (_ctx, s) => (typeof s.stack_id === 'string' ? s.stack_id : null) },
  'GET /services/{id}': serviceParam,
  'POST /services/{id}/scale': serviceParam,
  'POST /services/{id}/restart': serviceParam,
  'DELETE /services/{id}': serviceParam,
  'GET /services/{id}/env': serviceParam,
  'PATCH /services/{id}/env': serviceParam,
  'GET /services/{id}/logs': serviceParam,
  'GET /services/{id}/logs/stream': serviceParam,

  // `stack:<name>` polls a stack deploy; anything else is a service id.
  'GET /deployments/{id}': {
    kind: 'target',
    app: async (ctx, p) => {
      const id = p.id ?? '';
      return id.startsWith('stack:') ? id.slice('stack:'.length) : serviceStackName(ctx, id);
    },
  },
  'GET /deploys/{id}/events': { kind: 'result', app: (b) => (typeof b.stack === 'string' ? b.stack : null) },
};

interface CompiledRoute {
  method: string;
  re: RegExp;
  names: string[];
  rule: AppRule;
}

const COMPILED: CompiledRoute[] = Object.entries(APP_ROUTES).map(([key, rule]) => {
  const [method, path] = key.split(' ') as [string, string];
  const names: string[] = [];
  const re = new RegExp(
    `^${path.replace(/\{(\w+)\}/g, (_m, n: string) => {
      names.push(n);
      return '([^/]+)';
    })}$`,
  );
  return { method, re, names, rule };
});

/** The rule for a request (`/api/v1` prefix already stripped), or null = org-wide. */
export function appRuleFor(method: string, path: string): { rule: AppRule; params: Params } | null {
  const m = method.toUpperCase();
  for (const r of COMPILED) {
    if (r.method !== m) continue;
    const hit = r.re.exec(path);
    if (!hit) continue;
    const params: Params = {};
    r.names.forEach((n, i) => {
      params[n] = decodeURIComponent(hit[i + 1] ?? '');
    });
    return { rule: r.rule, params };
  }
  return null;
}

function relativePath(path: string): string {
  const i = path.indexOf('/api/v1/');
  const rel = i >= 0 ? path.slice(i + '/api/v1'.length) : path;
  return rel.length > 1 && rel.endsWith('/') ? rel.slice(0, -1) : rel;
}

function refuse(c: Context<RestEnv>, status: 403 | 404, detail: string) {
  return c.json(problem(status, detail, status === 403 ? 'POLICY_DENIED' : undefined), status, {
    'content-type': PROBLEM_CONTENT_TYPE,
  });
}

export function appScopeGate(): MiddlewareHandler<RestEnv> {
  return async (c, next) => {
    const allowed = c.get('apiKey').stackNames;
    if (!allowed) return next();
    const ctx = c.get('orgCtx');
    const hit = appRuleFor(c.req.method, relativePath(c.req.path));
    if (!hit) {
      return refuse(c, 403, `This API key is limited to ${allowed.join(', ')}; org-wide endpoints are off limits.`);
    }
    const { rule, params } = hit;
    if (rule.kind === 'allow') return next();
    if (rule.kind === 'target') {
      const app = await rule.app(ctx, params, c).catch(() => null);
      if (!keyReachesApp(allowed, app)) return refuse(c, 404, 'Not found');
      return next();
    }
    await next();
    if (c.res.status < 200 || c.res.status >= 300) return;
    if (!(c.res.headers.get('content-type') ?? '').includes('json')) return;
    const body = (await c.res.clone().json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return;
    if (rule.kind === 'result') {
      if (!keyReachesApp(allowed, rule.app(body))) c.res = refuse(c, 404, 'Not found');
      return;
    }
    const data = Array.isArray(body.data) ? (body.data as Record<string, unknown>[]) : null;
    if (!data) return;
    const kept = data.filter((item) => keyReachesApp(allowed, rule.app(ctx, item)));
    c.res = c.json({ ...body, data: kept }, 200);
  };
}
