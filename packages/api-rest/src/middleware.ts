import type { Context, MiddlewareHandler } from 'hono';
import type { OrgContext } from '@swarmy/trpc';
import type { ApiKeyScope, RestDeps } from './deps';
import { PROBLEM_CONTENT_TYPE, problem } from './problem';

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
