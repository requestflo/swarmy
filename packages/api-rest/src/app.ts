import { OpenAPIHono } from '@hono/zod-openapi';
import { apiReference } from '@scalar/hono-api-reference';
import type { RestDeps } from './deps';
import { apiKeyAuth, type RestEnv } from './middleware';
import { PROBLEM_CONTENT_TYPE, problem, trpcErrorToProblem } from './problem';
import { registerNodeRoutes } from './routes/nodes';
import { registerServiceRoutes } from './routes/services';
import { registerStackRoutes } from './routes/stacks';
import { registerIngressRoutes } from './routes/ingress';
import { registerApiKeyRoutes } from './routes/api-keys';
import { registerNodeActionRoutes } from './routes/node-actions';
import { registerDnsRecordRoutes } from './routes/dns-records';
import { registerBackupRoutes } from './routes/backups';
import { registerVolumeRoutes } from './routes/volumes';
import { registerMeshRouteRoutes } from './routes/mesh-routes';
import { idempotency } from './idempotency';

export const OPENAPI_DOC_ROUTE = '/openapi.json';
export const DOCS_ROUTE = '/docs';

/**
 * Build the OpenAPIHono app carrying every resource route. Auth is applied here
 * so the spec/docs (registered on the outer app) stay public. `withAuth=false`
 * is used only when assembling the spec at build time.
 */
function buildResourceApp(deps: RestDeps, withAuth = true): OpenAPIHono<RestEnv> {
  const app = new OpenAPIHono<RestEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const p = problem(400, 'Request validation failed');
        return c.json({ ...p, errors: result.error.issues }, 400, {
          'content-type': PROBLEM_CONTENT_TYPE,
        });
      }
    },
  });

  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerApiKey', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'swk',
    description: 'swarmy API key (`Authorization: Bearer swk_…`).',
  });

  if (withAuth) {
    app.use('*', apiKeyAuth(deps));
    // Idempotency must run AFTER auth — it reads c.get('orgCtx').
    app.use('*', idempotency());
  }

  registerNodeRoutes(app);
  registerNodeActionRoutes(app);
  registerServiceRoutes(app);
  registerStackRoutes(app);
  registerIngressRoutes(app);
  registerApiKeyRoutes(app);
  registerDnsRecordRoutes(app);
  registerBackupRoutes(app);
  registerVolumeRoutes(app);
  registerMeshRouteRoutes(app);

  app.onError((e, c) => {
    const p = trpcErrorToProblem(e, c.req.path);
    return c.json(p, p.status as 500, { 'content-type': PROBLEM_CONTENT_TYPE });
  });

  return app;
}

/** Assemble the OpenAPI 3.1 document from the registered routes. */
export function buildOpenApiDocument(deps: RestDeps): object {
  return buildResourceApp(deps, false).getOpenAPIDocument({
    openapi: '3.1.0',
    info: {
      title: 'swarmy API',
      version: '1.0.0',
      description:
        'Public, versioned REST API for swarmy. Authenticate with an org-scoped API key: `Authorization: Bearer swk_…`.',
    },
    servers: [{ url: '/api/v1' }],
  });
}

/**
 * The REST sub-app to mount at `/api/v1`. Serves the resource routes (API-key
 * authed), the OpenAPI document at `/openapi.json`, and Scalar docs at `/docs`
 * (both public). `deps.resolveContextFromApiKey` is the single seam where a key
 * becomes an OrgContext — wired in apps/api from `resolveOrgContextFromApiKey`.
 */
export function createRestApp(deps: RestDeps): OpenAPIHono<RestEnv> {
  const outer = new OpenAPIHono<RestEnv>();

  const doc = buildOpenApiDocument(deps);
  outer.get(OPENAPI_DOC_ROUTE, (c) => c.json(doc));
  outer.get(
    DOCS_ROUTE,
    apiReference({
      pageTitle: 'swarmy API',
      spec: { url: `/api/v1${OPENAPI_DOC_ROUTE}` },
    }),
  );

  // Mount the authed resource routes under the same base.
  outer.route('/', buildResourceApp(deps, true));

  return outer;
}
