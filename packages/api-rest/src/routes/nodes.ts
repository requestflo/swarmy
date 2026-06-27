import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { getNode, listNodes } from '@swarmy/trpc';
import type { RestEnv } from '../middleware';
import { requireScope } from '../middleware';
import { NodeDto, ProblemDto, listEnvelope } from '../dto';
import { nodeToDto } from '../mappers';
import { run } from '../respond';

const NodeList = listEnvelope(NodeDto, 'NodeList');
const idParam = z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' } }) });
const problemRes = {
  content: { 'application/problem+json': { schema: ProblemDto } },
  description: 'Problem',
};

export function registerNodeRoutes(app: OpenAPIHono<RestEnv>): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/nodes',
      tags: ['Nodes'],
      summary: 'List nodes',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('read')] as const,
      responses: {
        200: { content: { 'application/json': { schema: NodeList } }, description: 'Nodes' },
        401: problemRes,
      },
    }),
    (c) =>
      run(c, async () => {
        const nodes = await listNodes(c.get('orgCtx'));
        return { data: nodes.map(nodeToDto), next_cursor: null };
      }),
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/nodes/{id}',
      tags: ['Nodes'],
      summary: 'Get a node',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('read')] as const,
      request: { params: idParam },
      responses: {
        200: { content: { 'application/json': { schema: NodeDto } }, description: 'Node' },
        404: problemRes,
      },
    }),
    (c) =>
      run(c, async () => nodeToDto(await getNode(c.get('orgCtx'), c.req.param('id')))),
  );
}
