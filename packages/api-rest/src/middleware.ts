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
): MiddlewareHandler<RestEnv> {
  return async (c, next) => {
    const ctx = c.get('orgCtx');
    try {
      // Path params ARE the resolver input (`/services/{id}` → `{ id }`), the
      // same shape the tRPC procedure's input carries.
      const resourceInput = resolver ? await resolver(ctx, c.req.param()) : null;
      await authorize(ctx, action, resourceInput);
    } catch (e) {
      const p = trpcErrorToProblem(e, c.req.path);
      return c.json(p, p.status as 403, { 'content-type': PROBLEM_CONTENT_TYPE });
    }
    await next();
  };
}
