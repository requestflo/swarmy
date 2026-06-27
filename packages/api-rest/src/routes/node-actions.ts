import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { removeNode, setNodeAvailability, setNodeLabels } from '@swarmy/trpc';
import type { RestEnv } from '../middleware';
import { requireScope } from '../middleware';
import { ProblemDto, RemovedDto } from '../dto';
import { NodeAvailabilityDto, NodeLabelsDto, SetNodeLabelsBody } from '../dto-extra';
import { run } from '../respond';

const idParam = z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' } }) });
const problemRes = {
  content: { 'application/problem+json': { schema: ProblemDto } },
  description: 'Problem',
};
const jsonBody = <T extends z.ZodTypeAny>(schema: T) => ({
  content: { 'application/json': { schema } },
});

/**
 * Node lifecycle actions, layered on top of the read-only node routes. Swarm has
 * no separate "cordon" primitive: cordon == set availability `drain` (no new
 * tasks), uncordon == set availability `active`. Both reuse `setNodeAvailability`.
 */
export function registerNodeActionRoutes(app: OpenAPIHono<RestEnv>): void {
  app.openapi(
    createRoute({
      method: 'post',
      path: '/nodes/{id}/drain',
      tags: ['Nodes'],
      summary: 'Drain a node (cordon — stop scheduling, move tasks off)',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write')] as const,
      request: { params: idParam },
      responses: {
        200: { content: { 'application/json': { schema: NodeAvailabilityDto } }, description: 'Draining' },
        404: problemRes,
      },
    }),
    (c) => run(c, () => setNodeAvailability(c.get('orgCtx'), c.req.param('id'), 'drain')),
  );

  // Alias of drain — Swarm cordon == availability `drain`.
  app.openapi(
    createRoute({
      method: 'post',
      path: '/nodes/{id}/cordon',
      tags: ['Nodes'],
      summary: 'Cordon a node (alias of drain)',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write')] as const,
      request: { params: idParam },
      responses: {
        200: { content: { 'application/json': { schema: NodeAvailabilityDto } }, description: 'Cordoned' },
        404: problemRes,
      },
    }),
    (c) => run(c, () => setNodeAvailability(c.get('orgCtx'), c.req.param('id'), 'drain')),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/nodes/{id}/uncordon',
      tags: ['Nodes'],
      summary: 'Uncordon a node (restore availability `active`)',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write')] as const,
      request: { params: idParam },
      responses: {
        200: { content: { 'application/json': { schema: NodeAvailabilityDto } }, description: 'Active' },
        404: problemRes,
      },
    }),
    (c) => run(c, () => setNodeAvailability(c.get('orgCtx'), c.req.param('id'), 'active')),
  );

  app.openapi(
    createRoute({
      method: 'put',
      path: '/nodes/{id}/labels',
      tags: ['Nodes'],
      summary: 'Replace a node\'s labels',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write')] as const,
      request: { params: idParam, body: jsonBody(SetNodeLabelsBody) },
      responses: {
        200: { content: { 'application/json': { schema: NodeLabelsDto } }, description: 'Labels' },
        404: problemRes,
      },
    }),
    (c) =>
      run(c, () => setNodeLabels(c.get('orgCtx'), c.req.param('id'), c.req.valid('json').labels)),
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/nodes/{id}',
      tags: ['Nodes'],
      summary: 'Remove a node',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write')] as const,
      request: { params: idParam },
      responses: {
        200: { content: { 'application/json': { schema: RemovedDto } }, description: 'Removed' },
        404: problemRes,
      },
    }),
    (c) => run(c, () => removeNode(c.get('orgCtx'), c.req.param('id'))),
  );
}
