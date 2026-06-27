import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  createService,
  getServiceDetail,
  listServices,
  removeService,
  restartService,
  scaleService,
} from '@swarmy/trpc';
import type { RestEnv } from '../middleware';
import { requireScope } from '../middleware';
import {
  CreateServiceBody,
  DeploymentRefDto,
  ProblemDto,
  RemovedDto,
  ScaleBody,
  ServiceDto,
  listEnvelope,
} from '../dto';
import { serviceToDto } from '../mappers';
import { run } from '../respond';

const ServiceList = listEnvelope(ServiceDto, 'ServiceList');
const idParam = z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' } }) });
const problemRes = {
  content: { 'application/problem+json': { schema: ProblemDto } },
  description: 'Problem',
};
const jsonBody = <T extends z.ZodTypeAny>(schema: T) => ({
  content: { 'application/json': { schema } },
});

export function registerServiceRoutes(app: OpenAPIHono<RestEnv>): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/services',
      tags: ['Services'],
      summary: 'List services',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('read')] as const,
      responses: {
        200: { content: { 'application/json': { schema: ServiceList } }, description: 'Services' },
        401: problemRes,
      },
    }),
    (c) =>
      run(c, async () => {
        const rows = await listServices(c.get('orgCtx'));
        return { data: rows.map(serviceToDto), next_cursor: null };
      }),
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/services/{id}',
      tags: ['Services'],
      summary: 'Get a service',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('read')] as const,
      request: { params: idParam },
      responses: {
        200: { content: { 'application/json': { schema: ServiceDto } }, description: 'Service' },
        404: problemRes,
      },
    }),
    (c) => run(c, async () => serviceToDto(await getServiceDetail(c.get('orgCtx'), c.req.param('id')))),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/services',
      tags: ['Services'],
      summary: 'Create a service (async deploy)',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write')] as const,
      request: { body: jsonBody(CreateServiceBody) },
      responses: {
        202: {
          content: { 'application/json': { schema: DeploymentRefDto } },
          description: 'Accepted — deploy dispatched',
        },
        400: problemRes,
        403: problemRes,
      },
    }),
    (c) =>
      run(
        c,
        async () => {
          const b = c.req.valid('json');
          return createService(c.get('orgCtx'), {
            name: b.name,
            image: b.image,
            replicas: b.replicas ?? 1,
            command: b.command ?? [],
            env: b.env ?? [],
            ports: [],
            volumes: [],
            networks: [],
            constraints: [],
            nodeId: b.node_id,
          });
        },
        202,
      ),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/services/{id}/scale',
      tags: ['Services'],
      summary: 'Scale a service (async deploy)',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write')] as const,
      request: { params: idParam, body: jsonBody(ScaleBody) },
      responses: {
        202: { content: { 'application/json': { schema: DeploymentRefDto } }, description: 'Accepted' },
        404: problemRes,
      },
    }),
    (c) =>
      run(
        c,
        () =>
          scaleService(c.get('orgCtx'), {
            id: c.req.param('id'),
            replicas: c.req.valid('json').replicas,
          }),
        202,
      ),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/services/{id}/restart',
      tags: ['Services'],
      summary: 'Restart a service (async deploy)',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write')] as const,
      request: { params: idParam },
      responses: {
        202: { content: { 'application/json': { schema: DeploymentRefDto } }, description: 'Accepted' },
        404: problemRes,
      },
    }),
    (c) => run(c, () => restartService(c.get('orgCtx'), c.req.param('id')), 202),
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/services/{id}',
      tags: ['Services'],
      summary: 'Remove a service',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write')] as const,
      request: { params: idParam },
      responses: {
        200: { content: { 'application/json': { schema: RemovedDto } }, description: 'Removed' },
        404: problemRes,
      },
    }),
    (c) => run(c, () => removeService(c.get('orgCtx'), c.req.param('id'))),
  );
}
