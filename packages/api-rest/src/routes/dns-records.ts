import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  checkDnsDelegation,
  createDnsZone,
  listDnsRecords,
  listDnsZones,
  removeDnsRecord,
  removeDnsZone,
  upsertDnsRecord,
} from '@swarmy/trpc';
import type { RestEnv } from '../middleware';
import { requireScope } from '../middleware';
import { ProblemDto, RemovedDto, listEnvelope } from '../dto';
import { CreateDnsZoneBody, DnsRecordDto, DnsZoneDto, UpsertDnsRecordBody } from '../dto-extra';
import { dnsRecordToDto, dnsZoneToDto } from '../mappers-extra';
import { run } from '../respond';

const DnsZoneList = listEnvelope(DnsZoneDto, 'DnsZoneList');
const DnsRecordList = listEnvelope(DnsRecordDto, 'DnsRecordList');
const idParam = z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' } }) });
const problemRes = {
  content: { 'application/problem+json': { schema: ProblemDto } },
  description: 'Problem',
};
const jsonBody = <T extends z.ZodTypeAny>(schema: T) => ({
  content: { 'application/json': { schema } },
});

/**
 * Geo-DNS ("swarmy is the nameserver"): zones + manual static records.
 * Web A records are DERIVED from ingress and have no CRUD here by design.
 */
export function registerDnsRecordRoutes(app: OpenAPIHono<RestEnv>): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/dns/zones',
      tags: ['DNS'],
      summary: 'List DNS zones',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('read')] as const,
      responses: {
        200: { content: { 'application/json': { schema: DnsZoneList } }, description: 'Zones' },
        401: problemRes,
      },
    }),
    (c) =>
      run(c, async () => {
        const zones = await listDnsZones(c.get('orgCtx'));
        return { data: zones.map(dnsZoneToDto), next_cursor: null };
      }),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/dns/zones',
      tags: ['DNS'],
      summary: 'Create a DNS zone',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write')] as const,
      request: { body: jsonBody(CreateDnsZoneBody) },
      responses: {
        200: { content: { 'application/json': { schema: DnsZoneDto } }, description: 'Created' },
        400: problemRes,
      },
    }),
    (c) =>
      run(c, async () => dnsZoneToDto(await createDnsZone(c.get('orgCtx'), c.req.valid('json')))),
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/dns/zones/{id}',
      tags: ['DNS'],
      summary: 'Remove a DNS zone',
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
        const removed = await removeDnsZone(c.get('orgCtx'), c.req.param('id'));
        return { id: removed.id, removed: true as const };
      }),
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/dns/zones/{id}/delegation',
      tags: ['DNS'],
      summary: 'Check registrar delegation for a zone',
      description:
        'Public NS lookup compared to the advertised nameserver set, plus a direct SOA probe of each glue IP.',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('read')] as const,
      request: { params: idParam },
      responses: {
        200: {
          content: {
            'application/json': {
              schema: z
                .object({
                  zone: z.string(),
                  delegated: z.boolean(),
                  public_ns: z.array(z.string()),
                  nameservers: z.array(
                    z.object({
                      fqdn: z.string(),
                      ip: z.string(),
                      reachable: z.boolean(),
                      serial: z.number().nullable(),
                      serial_matches: z.boolean(),
                    }),
                  ),
                })
                .openapi('DnsDelegationCheck'),
            },
          },
          description: 'Delegation status',
        },
        404: problemRes,
      },
    }),
    (c) =>
      run(c, async () => {
        const check = await checkDnsDelegation(c.get('orgCtx'), c.req.param('id'));
        return {
          zone: check.zone,
          delegated: check.delegated,
          public_ns: check.publicNs,
          nameservers: check.nameservers.map((ns) => ({
            fqdn: ns.fqdn,
            ip: ns.ip,
            reachable: ns.reachable,
            serial: ns.serial,
            serial_matches: ns.serialMatches,
          })),
        };
      }),
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/dns/zones/{id}/records',
      tags: ['DNS'],
      summary: 'List manual records in a zone (MX/TXT/CNAME/…)',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('read')] as const,
      request: { params: idParam },
      responses: {
        200: { content: { 'application/json': { schema: DnsRecordList } }, description: 'Records' },
        404: problemRes,
      },
    }),
    (c) =>
      run(c, async () => {
        const rows = await listDnsRecords(c.get('orgCtx'), c.req.param('id'));
        return { data: rows.map(dnsRecordToDto), next_cursor: null };
      }),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/dns/zones/{id}/records',
      tags: ['DNS'],
      summary: 'Create or update a manual record (upsert by name+type+value)',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write')] as const,
      request: { params: idParam, body: jsonBody(UpsertDnsRecordBody) },
      responses: {
        200: { content: { 'application/json': { schema: DnsRecordDto } }, description: 'Upserted' },
        400: problemRes,
      },
    }),
    (c) =>
      run(c, async () => {
        const b = c.req.valid('json');
        return dnsRecordToDto(
          await upsertDnsRecord(c.get('orgCtx'), { zoneId: c.req.param('id'), ...b }),
        );
      }),
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/dns/records/{id}',
      tags: ['DNS'],
      summary: 'Remove a manual record',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write')] as const,
      request: { params: idParam },
      responses: {
        200: { content: { 'application/json': { schema: RemovedDto } }, description: 'Removed' },
        404: problemRes,
      },
    }),
    (c) => run(c, () => removeDnsRecord(c.get('orgCtx'), c.req.param('id'))),
  );
}
