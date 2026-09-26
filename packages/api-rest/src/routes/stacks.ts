import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { getStack, listStacks, removeStack, resolveStack, resolveStackByName } from '@swarmy/trpc';
import { deployComposeTraced } from '@swarmy/trpc/devx';
import type { RestEnv } from '../middleware';
import { requireAction, requireScope } from '../middleware';
import {
  DeployStackBody,
  DeploymentRefDto,
  ProblemDto,
  StackDto,
  StackRemovedDto,
  listEnvelope,
} from '../dto';
import { deploymentRefToDto, stackToDto } from '../mappers';
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
      middleware: [
        requireScope('write'),
        requireAction('stack.deploy', resolveStackByName, (b) => ({ name: b.name, composeSource: b.compose_source })),
      ] as const,
      request: { body: { content: { 'application/json': { schema: DeployStackBody } } } },
      responses: {
        202: { content: { 'application/json': { schema: DeploymentRefDto } }, description: 'Accepted' },
        400: problemRes,
      },
    }),
    (c) =>
      run(
        c,
        async () => {
          const b = c.req.valid('json');
          // The declared DeploymentRef; `deployment_id` (`stack:<name>`) polls
          // the whole stack's convergence at GET /deployments/{id}, and
          // `deploy_id` its step-by-step events at GET /deploys/{id}/events.
          return deploymentRefToDto(
            await deployComposeTraced(c.get('orgCtx'), {
              name: b.name,
              composeSource: b.compose_source,
            }),
          );
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
      description:
        "Stops and removes every service in the stack. Its data — the named volumes on every server and the secrets its blueprint generated — is KEPT unless `delete_data=true`, so redeploying the same name picks the old data back up. Audited.",
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write'), requireAction('stack.remove', resolveStack)] as const,
      request: {
        params: idParam,
        query: z.object({
          delete_data: z
            .enum(['true', 'false'])
            .optional()
            .openapi({ param: { name: 'delete_data', in: 'query' }, description: "Also delete the app's data (default false)." }),
        }),
      },
      responses: {
        200: { content: { 'application/json': { schema: StackRemovedDto } }, description: 'Removed' },
        404: problemRes,
      },
    }),
    (c) =>
      run(c, async () => {
        const r = await removeStack(c.get('orgCtx'), c.req.param('id'), {
          deleteData: c.req.valid('query').delete_data === 'true',
        });
        return {
          id: r.id,
          removed: r.removed,
          delete_data: r.deleteData,
          volumes_deleted: r.volumesDeleted,
          volumes_kept: r.volumesKept,
        };
      }),
  );
}
