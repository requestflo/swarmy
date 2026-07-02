import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { appRouter } from '@swarmy/trpc';
import type { RestEnv } from '../middleware';
import { requireScope } from '../middleware';
import { ProblemDto } from '../dto';
import { PROBLEM_CONTENT_TYPE, trpcErrorToProblem } from '../problem';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * Audit-log REST routes (slice E5): `GET /api/v1/audit/export` — the whole
 * filtered audit trail as a CSV or JSON download (max 10 000 rows), for
 * compliance tooling and cron pulls. Filters mirror the dashboard's `audit.list`
 * tRPC procedure; the body is produced by the same service via a server-side
 * router caller, so REST and dashboard exports can never drift.
 */

const problemRes = {
  content: { 'application/problem+json': { schema: ProblemDto } },
  description: 'Problem',
};

const q = (name: string) => ({ param: { name, in: 'query' as const } });

const ExportQuery = z.object({
  actor: z.string().optional().openapi({ ...q('actor'), description: 'Exact actor id' }),
  actor_type: z.enum(['user', 'apikey', 'system', 'agent']).optional().openapi(q('actor_type')),
  action: z
    .string()
    .optional()
    .openapi({ ...q('action'), description: 'Action PREFIX, e.g. `secrets.`' }),
  resource_type: z.string().optional().openapi(q('resource_type')),
  resource_id: z.string().optional().openapi(q('resource_id')),
  from: z.string().optional().openapi({ ...q('from'), description: 'ISO date/datetime lower bound' }),
  to: z.string().optional().openapi({ ...q('to'), description: 'ISO date/datetime upper bound' }),
  format: z.enum(['csv', 'json']).default('csv').openapi(q('format')),
});

export function registerAuditRoutes(app: OpenAPIHono<RestEnv>): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/audit/export',
      tags: ['Audit'],
      summary: 'Export the org audit log (CSV or JSON, max 10 000 rows)',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('read')] as const,
      request: { query: ExportQuery },
      responses: {
        200: {
          content: {
            'text/csv': { schema: z.string() },
            'application/json': { schema: z.string() },
          },
          description:
            'The export body. `X-Swarmy-Row-Count` carries the row count; `X-Swarmy-Truncated: true` means the filter matched more than the 10k cap.',
        },
        401: problemRes,
        403: problemRes,
      },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (c): Promise<any> => {
      try {
        const query = c.req.valid('query');
        // Same service path as the dashboard: orgProcedure re-verifies membership.
        const caller = appRouter.createCaller(c.get('orgCtx'));
        const result = await caller.audit.export({
          actor: query.actor,
          actorType: query.actor_type,
          action: query.action,
          resourceType: query.resource_type,
          resourceId: query.resource_id,
          from: query.from,
          to: query.to,
          format: query.format,
        });
        c.header('content-type', result.contentType);
        c.header('content-disposition', `attachment; filename="${result.filename}"`);
        c.header('x-swarmy-row-count', String(result.rowCount));
        if (result.truncated) c.header('x-swarmy-truncated', 'true');
        return c.body(result.content, 200);
      } catch (e) {
        const p = trpcErrorToProblem(e, c.req.path);
        return c.json(p, p.status as ContentfulStatusCode, {
          'content-type': PROBLEM_CONTENT_TYPE,
        });
      }
    },
  );
}
