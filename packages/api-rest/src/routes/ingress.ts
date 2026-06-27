import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { addDomain, listDomains, removeDomain } from '@swarmy/trpc';
import type { TlsMode } from '@swarmy/core';
import type { RestEnv } from '../middleware';
import { requireScope } from '../middleware';
import { AddDomainBody, DomainDto, ProblemDto, RemovedDto, listEnvelope } from '../dto';
import { domainToDto } from '../mappers';
import { run } from '../respond';

const DomainList = listEnvelope(DomainDto, 'IngressDomainList');
const idParam = z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' } }) });
const problemRes = {
  content: { 'application/problem+json': { schema: ProblemDto } },
  description: 'Problem',
};

export function registerIngressRoutes(app: OpenAPIHono<RestEnv>): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/ingress/domains',
      tags: ['Ingress'],
      summary: 'List ingress domains',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('read')] as const,
      responses: {
        200: { content: { 'application/json': { schema: DomainList } }, description: 'Domains' },
        401: problemRes,
      },
    }),
    (c) =>
      run(c, async () => {
        const rows = await listDomains(c.get('orgCtx'));
        return { data: rows.map(domainToDto), next_cursor: null };
      }),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/ingress/domains',
      tags: ['Ingress'],
      summary: 'Add an ingress domain',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write')] as const,
      request: { body: { content: { 'application/json': { schema: AddDomainBody } } } },
      responses: {
        201: { content: { 'application/json': { schema: DomainDto } }, description: 'Created' },
        400: problemRes,
        404: problemRes,
      },
    }),
    (c) =>
      run(
        c,
        async () => {
          const b = c.req.valid('json');
          return domainToDto(
            await addDomain(c.get('orgCtx'), {
              host: b.host,
              serviceId: b.service_id,
              targetPort: b.target_port,
              tls: (b.tls ?? 'auto') as TlsMode,
              pathPrefix: b.path_prefix,
            }),
          );
        },
        201,
      ),
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/ingress/domains/{id}',
      tags: ['Ingress'],
      summary: 'Remove an ingress domain',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write')] as const,
      request: { params: idParam },
      responses: {
        200: { content: { 'application/json': { schema: RemovedDto } }, description: 'Removed' },
        404: problemRes,
      },
    }),
    (c) => run(c, () => removeDomain(c.get('orgCtx'), c.req.param('id'))),
  );
}
