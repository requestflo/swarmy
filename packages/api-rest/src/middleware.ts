import type { Context, MiddlewareHandler } from 'hono';
import { authorize, type OrgContext, type ResolveResource } from '@swarmy/trpc';
import type { ApiKeyScope, RestDeps } from './deps';
import { PROBLEM_CONTENT_TYPE, problem, trpcErrorToProblem } from './problem';

/** Hono context variables populated by {@link apiKeyAuth}. */
export interface RestEnv {
  Variables: {
    orgCtx: OrgContext;
    apiKey: { id: string; scopes: ApiKeyScope[] };
  };
}

function unauthorized(c: Context, detail: string) {
  c.header('WWW-Authenticate', 'Bearer realm="swarmy", error="invalid_token"');
  return c.json(problem(401, detail), 401, { 'content-type': PROBLEM_CONTENT_TYPE });
}

/**
 * Bearer-API-key auth middleware. Resolves the same OrgContext as the dashboard
 * and stashes it (+ the key's scopes) on the Hono context for handlers/services.
 */
export function apiKeyAuth(deps: RestDeps): MiddlewareHandler<RestEnv> {
  return async (c, next) => {
    const header = c.req.header('authorization') ?? c.req.header('Authorization');
    if (!header) return unauthorized(c, 'Missing Authorization: Bearer <swk_…> header');

    const resolved = await deps.resolveContextFromApiKey(header).catch(() => null);
    if (!resolved) return unauthorized(c, 'Invalid or revoked API key');

    c.set('orgCtx', resolved.ctx);
    c.set('apiKey', resolved.apiKey);
    await next();
  };
}

/** Require a scope for the route (read for GET, write for mutations). */
export function requireScope(scope: ApiKeyScope): MiddlewareHandler<RestEnv> {
  return async (c, next) => {
    const key = c.get('apiKey');
    const ok = key.scopes.includes(scope) || (scope === 'read' && key.scopes.includes('write'));
    if (!ok) {
      return c.json(
        problem(403, `API key lacks "${scope}" scope`, 'POLICY_DENIED'),
        403,
        { 'content-type': PROBLEM_CONTENT_TYPE },
      );
    }
    await next();
  };
}

/**
 * Fine-grained policy gate for a REST route — the REST twin of tRPC's
 * `abacProcedure(action, resolver)`. Runs AFTER `requireScope` (scope is the
 * key's coarse ceiling; this is the org's policy) and calls the SAME
 * `authorize` step, so a key acting as its creator gets the identical decision
 * and `authz.permit|deny:<action>` audit row a dashboard call would. Destructive
 * routes (DELETE, drain, restore, …) carry this; `resolve` receives the path
 * params so a resource-scoped policy (labels, ReBAC grants) applies.
 */
export function requireAction(
  action: Parameters<typeof authorize>[1],
  resolver?: ResolveResource,
  /**
   * For create/deploy routes whose resource is in the BODY (a new stack's
   * name + compose): map the JSON body to the resolver's tRPC-shaped input.
   * Hono caches the parsed body, so the route's validator still sees it.
   */
  fromBody?: (body: Record<string, unknown>) => Record<string, unknown>,
): MiddlewareHandler<RestEnv> {
  return async (c, next) => {
    const ctx = c.get('orgCtx');
    try {
      // Path params ARE the resolver input (`/services/{id}` → `{ id }`), the
      // same shape the tRPC procedure's input carries.
      let input: Record<string, unknown> = c.req.param();
      if (fromBody) {
        const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown> | null;
        input = { ...input, ...fromBody(body && typeof body === 'object' ? body : {}) };
      }
      const resourceInput = resolver ? await resolver(ctx, input) : null;
      await authorize(ctx, action, resourceInput);
    } catch (e) {
      const p = trpcErrorToProblem(e, c.req.path);
      return c.json(p, p.status as 403, { 'content-type': PROBLEM_CONTENT_TYPE });
    }
    await next();
  };
}

/**
 * REST twin of tRPC's `adminProcedure` (`role !== 'member'`): the key acts as
 * its creator's CURRENT role (resolved per request in `apiKeyContext`), so a
 * member-minted key can't do over REST what the dashboard refuses a member.
 * Runs after `requireScope`. Use on routes whose tRPC procedure is
 * `adminProcedure`; destructive routes use `requireAction` instead.
 */
export function requireAdmin(): MiddlewareHandler<RestEnv> {
  return async (c, next) => {
    if (c.get('orgCtx').membership.role === 'member') {
      return c.json(problem(403, 'requires admin or owner', 'POLICY_DENIED'), 403, {
        'content-type': PROBLEM_CONTENT_TYPE,
      });
    }
    await next();
  };
}
