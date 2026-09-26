import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import { getDeployEvents } from '@swarmy/trpc/devx';
import type { RestEnv } from '../middleware';
import { requireScope } from '../middleware';
import { ProblemDto } from '../dto';
import { PROBLEM_CONTENT_TYPE } from '../problem';
import { run } from '../respond';

/**
 * A traced deploy's events — the same stream the dashboard's Deploying
 * screen follows (`deploys.get`): the image pull (layers, digest), its data,
 * the app starting, the certificate and the health check. The id is the
 * `deploy_id` POST /stacks returns; events stay for 30 min after the last one.
 */
const DeployEventDto = z
  .object({
    seq: z.number().int(),
    at: z.number().int().openapi({ description: 'Epoch ms.' }),
    stage: z.enum(['pull', 'data', 'start', 'route', 'health']).openapi({ description: 'Open set.' }),
    status: z.enum(['started', 'progress', 'done', 'failed']),
    node: z.string().openapi({ description: 'The server it happened on (`swarmy` for the controller’s own steps).' }),
    service: z.string().nullable(),
    message: z.string(),
    detail: z
      .object({
        layers_total: z.number().int().optional(),
        layers_done: z.number().int().optional(),
        bytes_total: z.number().int().optional(),
        bytes_done: z.number().int().optional(),
        digest: z.string().optional(),
        image: z.string().optional(),
        replicas_running: z.number().int().optional(),
        replicas_desired: z.number().int().optional(),
        host: z.string().optional(),
      })
      .nullable(),
  })
  .openapi('DeployEvent');

const DeployEventsDto = z
  .object({
    deploy_id: z.string(),
    stack: z.string(),
    started_at: z.number().int(),
    done: z.boolean().openapi({ description: 'Live, failed, or no longer watched: no more events will come.' }),
    data: z.array(DeployEventDto),
  })
  .openapi('DeployEvents');

const problemRes = { content: { [PROBLEM_CONTENT_TYPE]: { schema: ProblemDto } }, description: 'Problem' };

export function registerDeployRoutes(app: OpenAPIHono<RestEnv>): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/deploys/{id}/events',
      tags: ['Stacks'],
      summary: 'A deploy’s progress events (poll while it runs)',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('read')] as const,
      request: { params: z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' }, description: 'The `deploy_id` from POST /stacks.' }) }) },
      responses: {
        200: { content: { 'application/json': { schema: DeployEventsDto } }, description: 'Events so far' },
        404: problemRes,
      },
    }),
    (c) =>
      run(c, async () => {
        const t = getDeployEvents(c.get('orgCtx'), c.req.param('id'));
        return {
          deploy_id: t.deployId,
          stack: t.stack,
          started_at: t.startedAt,
          done: t.done,
          data: t.events.map((e) => ({
            seq: e.seq,
            at: e.at,
            stage: e.stage,
            status: e.status,
            node: e.node,
            service: e.service ?? null,
            message: e.message,
            detail: e.detail
              ? {
                  layers_total: e.detail.layersTotal,
                  layers_done: e.detail.layersDone,
                  bytes_total: e.detail.bytesTotal,
                  bytes_done: e.detail.bytesDone,
                  digest: e.detail.digest,
                  image: e.detail.image,
                  replicas_running: e.detail.replicasRunning,
                  replicas_desired: e.detail.replicasDesired,
                  host: e.detail.host,
                }
              : null,
          })),
        };
      }),
  );
}
