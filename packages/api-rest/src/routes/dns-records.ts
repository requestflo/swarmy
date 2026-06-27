import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { listDnsRecords, removeDnsRecord, upsertDnsRecord } from '@swarmy/trpc';
import type { RestEnv } from '../middleware';
import { requireScope } from '../middleware';
import { ProblemDto, RemovedDto, listEnvelope } from '../dto';
import { DnsRecordDto, UpsertDnsRecordBody } from '../dto-extra';
import { dnsRecordToDto } from '../mappers-extra';
import { run } from '../respond';

const DnsRecordList = listEnvelope(DnsRecordDto, 'DnsRecordList');
const idParam = z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' } }) });
const problemRes = {
  content: { 'application/problem+json': { schema: ProblemDto } },
  description: 'Problem',
};
const jsonBody = <T extends z.ZodTypeAny>(schema: T) => ({
  content: { 'application/json': { schema } },
});

/** Geo-DNS (GSLB) records — region-aware A/CNAME endpoints for a host. */
export function registerDnsRecordRoutes(app: OpenAPIHono<RestEnv>): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/dns/records',
      tags: ['DNS'],
      summary: 'List geo-DNS records',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('read')] as const,
      responses: {
        200: { content: { 'application/json': { schema: DnsRecordList } }, description: 'Records' },
        401: problemRes,
      },
    }),
    (c) =>
      run(c, async () => {
        const rows = await listDnsRecords(c.get('orgCtx'));
        return { data: rows.map(dnsRecordToDto), next_cursor: null };
      }),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/dns/records',
      tags: ['DNS'],
      summary: 'Create or update a geo-DNS record (upsert by host+region)',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write')] as const,
      request: { body: jsonBody(UpsertDnsRecordBody) },
      responses: {
        200: { content: { 'application/json': { schema: DnsRecordDto } }, description: 'Upserted' },
        400: problemRes,
      },
    }),
    (c) =>
      run(c, async () => {
        const b = c.req.valid('json');
        return dnsRecordToDto(
          await upsertDnsRecord(c.get('orgCtx'), {
            host: b.host,
            region: b.region,
            targetIngress: b.target_ingress,
            healthy: b.healthy,
          }),
        );
      }),
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/dns/records/{id}',
      tags: ['DNS'],
      summary: 'Remove a geo-DNS record',
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
