import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { deployFromCompose, getStack, listStacks, removeStack } from '@swarmy/trpc';
import type { RestEnv } from '../middleware';
import { requireScope } from '../middleware';
import {
  DeployStackBody,
  DeploymentRefDto,
  ProblemDto,
  RemovedDto,
  StackDto,
  listEnvelope,
} from '../dto';
import { stackToDto } from '../mappers';
import { run } from '../respond';

const StackList = listEnvelope(StackDto, 'StackList');
const idParam = z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' } }) });
const problemRes = {
  content: { 'application/problem+json': { schema: ProblemDto } },
  description: 'Problem',
};

export function registerStackRoutes(app: OpenAPIHono<RestEnv>): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/stacks',
      tags: ['Stacks'],
      summary: 'List stacks',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('read')] as const,
      responses: {
        200: { content: { 'application/json': { schema: StackList } }, description: 'Stacks' },
        401: problemRes,
      },
    }),
    (c) =>
      run(c, async () => {
        const rows = await listStacks(c.get('orgCtx'));
        return { data: rows.map(stackToDto), next_cursor: null };
      }),
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/stacks/{id}',
      tags: ['Stacks'],
      summary: 'Get a stack',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('read')] as const,
      request: { params: idParam },
      responses: {
        200: { content: { 'application/json': { schema: StackDto } }, description: 'Stack' },
        404: problemRes,
      },
    }),
    (c) => run(c, async () => stackToDto(await getStack(c.get('orgCtx'), c.req.param('id')))),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/stacks',
      tags: ['Stacks'],
      summary: 'Deploy a stack from a compose document (async)',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write')] as const,
      request: { body: { content: { 'application/json': { schema: DeployStackBody } } } },
      responses: {
        202: { content: { 'application/json': { schema: DeploymentRefDto } }, description: 'Accepted' },
        400: problemRes,
      },
    }),
    (c) =>
      run(
        c,
        () => {
          const b = c.req.valid('json');
          return deployFromCompose(c.get('orgCtx'), {
            name: b.name,
            composeSource: b.compose_source,
          });
        },
        202,
      ),
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/stacks/{id}',
      tags: ['Stacks'],
      summary: 'Remove a stack',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write')] as const,
      request: { params: idParam },
      responses: {
        200: { content: { 'application/json': { schema: RemovedDto } }, description: 'Removed' },
        404: problemRes,
      },
    }),
    (c) => run(c, () => removeStack(c.get('orgCtx'), c.req.param('id'))),
  );
}
