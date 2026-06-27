import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { grantDirectRoute, listMeshRoutes, revokeDirectRoute } from '@swarmy/trpc';
import type { RestEnv } from '../middleware';
import { requireScope } from '../middleware';
import { ProblemDto, RemovedDto, listEnvelope } from '../dto';
import { GrantMeshRouteBody, GrantMeshRouteDto, MeshRouteDto } from '../dto-extra';
import { grantMeshRouteToDto, meshRouteToDto } from '../mappers-extra';
import { run } from '../respond';

const MeshRouteList = listEnvelope(MeshRouteDto, 'MeshRouteList');
const idParam = z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' } }) });
const problemRes = {
  content: { 'application/problem+json': { schema: ProblemDto } },
  description: 'Problem',
};
const jsonBody = <T extends z.ZodTypeAny>(schema: T) => ({
  content: { 'application/json': { schema } },
});

/** Zero-trust mesh direct routes (point-to-point service/stack grants). */
export function registerMeshRouteRoutes(app: OpenAPIHono<RestEnv>): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/mesh/routes',
      tags: ['Mesh'],
      summary: 'List mesh routes',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('read')] as const,
      responses: {
        200: { content: { 'application/json': { schema: MeshRouteList } }, description: 'Routes' },
        401: problemRes,
      },
    }),
    (c) =>
      run(c, async () => {
        const rows = await listMeshRoutes(c.get('orgCtx'));
        return { data: rows.map(meshRouteToDto), next_cursor: null };
      }),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/mesh/routes',
      tags: ['Mesh'],
      summary: 'Grant a direct mesh route to a service/stack',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write')] as const,
      request: { body: jsonBody(GrantMeshRouteBody) },
      responses: {
        201: {
          content: { 'application/json': { schema: GrantMeshRouteDto } },
          description: 'Granted — carries connection info',
        },
        400: problemRes,
        404: problemRes,
      },
    }),
    (c) =>
      run(
        c,
        async () => {
          const b = c.req.valid('json');
          return grantMeshRouteToDto(
            await grantDirectRoute(c.get('orgCtx'), {
              serviceId: b.service_id,
              stackId: b.stack_id,
              principalType: b.principal_type,
              principalId: b.principal_id,
              port: b.port,
              proto: b.proto,
              ttlSec: b.ttl_sec,
            }),
          );
        },
        201,
      ),
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/mesh/routes/{id}',
      tags: ['Mesh'],
      summary: 'Revoke a mesh route',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write')] as const,
      request: { params: idParam },
      responses: {
        200: { content: { 'application/json': { schema: RemovedDto } }, description: 'Removed' },
        404: problemRes,
      },
    }),
    (c) =>
      run(c, async () => {
        await revokeDirectRoute(c.get('orgCtx'), c.req.param('id'));
        return { id: c.req.param('id'), removed: true as const };
      }),
  );
}
