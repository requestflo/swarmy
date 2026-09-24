import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  addDomain,
  getDomainStatus,
  listDomains,
  parseDomainId,
  removeDomain,
  resolveService,
  setDomainWww,
  verifyDomainNow,
  type ResolveResource,
} from '@swarmy/trpc';
import type { TlsMode } from '@swarmy/core';
import type { RestEnv } from '../middleware';
import { requireAction, requireScope } from '../middleware';
import { AddDomainBody, DomainDetailDto, DomainDto, ProblemDto, RemovedDto, UpdateDomainBody, listEnvelope } from '../dto';
import { domainDetailToDto, domainToDto } from '../mappers';
import { run } from '../respond';

/**
 * A domain inherits its target service's live labels (a production service's
 * domain is production) — the same resolution as the tRPC ingress router.
 * `{ id }` is the domain id path param; `{ serviceId }` comes from the body.
 */
const resolveDomain: ResolveResource = (ctx, input) => {
  const id = (input as { id?: unknown } | null)?.id;
  return typeof id === 'string' && id ? resolveService(ctx, { id: parseDomainId(id).serviceId }) : null;
};
const resolveRouteService: ResolveResource = (ctx, input) => {
  const serviceId = (input as { serviceId?: unknown } | null)?.serviceId;
  return typeof serviceId === 'string' && serviceId ? resolveService(ctx, { id: serviceId }) : null;
};

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
      middleware: [
        requireScope('write'),
        requireAction('ingress.write', resolveRouteService, (b) => ({ serviceId: b.service_id })),
      ] as const,
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
              www: b.www ?? null,
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
      middleware: [requireScope('write'), requireAction('ingress.write', resolveDomain)] as const,
      request: { params: idParam },
      responses: {
        200: { content: { 'application/json': { schema: RemovedDto } }, description: 'Removed' },
        404: problemRes,
      },
    }),
    (c) => run(c, () => removeDomain(c.get('orgCtx'), c.req.param('id'))),
  );

  const hostOf = (id: string) => parseDomainId(id).host;

  app.openapi(
    createRoute({
      method: 'get',
      path: '/ingress/domains/{id}/status',
      tags: ['Ingress'],
      summary: 'Domain DNS + certificate status',
      description:
        'Lifecycle state (waiting_dns → verified → issuing → active | error), the exact DNS records to create, what public DNS answers, and the certificate each edge serves.',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('read')] as const,
      request: { params: idParam },
      responses: {
        200: { content: { 'application/json': { schema: DomainDetailDto } }, description: 'Status' },
        404: problemRes,
      },
    }),
    (c) => run(c, async () => domainDetailToDto(await getDomainStatus(c.get('orgCtx'), hostOf(c.req.param('id'))))),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/ingress/domains/{id}/verify',
      tags: ['Ingress'],
      summary: 'Re-check a domain now',
      description: 'Runs the DNS (and, once verified, certificate) check immediately instead of waiting for the next scheduled check.',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write'), requireAction('ingress.write', resolveDomain)] as const,
      request: { params: idParam },
      responses: {
        200: { content: { 'application/json': { schema: DomainDetailDto } }, description: 'Status after the check' },
        404: problemRes,
      },
    }),
    (c) => run(c, async () => domainDetailToDto(await verifyDomainNow(c.get('orgCtx'), hostOf(c.req.param('id'))))),
  );

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/ingress/domains/{id}',
      tags: ['Ingress'],
      summary: 'Update a domain (apex ↔ www)',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write'), requireAction('ingress.write', resolveDomain)] as const,
      request: { params: idParam, body: { content: { 'application/json': { schema: UpdateDomainBody } } } },
      responses: {
        200: { content: { 'application/json': { schema: DomainDto } }, description: 'Updated' },
        400: problemRes,
        404: problemRes,
      },
    }),
    (c) =>
      run(c, async () => {
        const b = c.req.valid('json');
        return domainToDto(await setDomainWww(c.get('orgCtx'), c.req.param('id'), b.www));
      }),
  );
}
