import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import {
  connectStacks,
  disconnectStacks,
  resolveStackByName,
  stackEndpointsFor,
  stackNameForId,
  type ResolveResource,
} from '@swarmy/trpc';
import type { RestEnv } from '../middleware';
import { requireActionAll, requireScope } from '../middleware';
import { ProblemDto } from '../dto';
import { ConnectStackBody, StackConnectionDto, StackEndpointsDto } from '../dto-extra';
import { stackConnectionToDto, stackEndpointsToDto } from '../mappers-extra';
import { run } from '../respond';

/**
 * "Connect apps" + "how do I reach it" over REST — the same services as tRPC
 * `stacks.endpoints` / `connect` / `disconnect`:
 *
 *   GET    /stacks/{id}/endpoints            internal DNS names + managed resources
 *   POST   /stacks/{id}/connections          connect this app to `peer` (one private overlay)
 *   DELETE /stacks/{id}/connections/{peer}   disconnect them
 *
 * `{id}` and `peer` are a stack id or name (label-only stacks are listed with
 * their name as id). Connecting changes BOTH apps, so — like `stacks.connect`
 * — the caller needs `stack.deploy` on each.
 */

const TAG = 'Stacks';
const problemRes = {
  content: { 'application/problem+json': { schema: ProblemDto } },
  description: 'Problem',
};
const idParam = z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' } }) });

/** `{ id }` → this stack, resolved by name exactly as `stacks.connect` resolves `stack`. */
const resolveThisStack: ResolveResource = async (ctx, input) => {
  const id = (input as { id?: unknown } | null)?.id;
  return typeof id === 'string' && id ? resolveStackByName(ctx, { stack: await stackNameForId(ctx, id) }) : null;
};

/** `{ peer }` (path or body) → the peer stack (tRPC's `resolvePeerStack`). */
const resolvePeer: ResolveResource = async (ctx, input) => {
  const peer = (input as { peer?: unknown } | null)?.peer;
  return typeof peer === 'string' && peer ? resolveStackByName(ctx, { stack: await stackNameForId(ctx, peer) }) : null;
};

const bothStacks = [resolveThisStack, resolvePeer];

export function registerStackConnectionRoutes(app: OpenAPIHono<RestEnv>): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/stacks/{id}/endpoints',
      tags: [TAG],
      summary: "How to reach an app's services and managed resources from inside the cluster",
      description:
        'The internal DNS names swarm answers for each service (`web` in-app, `shop_web`, `tasks.web`, `web.shop` from a connected app) and the host:port of each managed resource, with who can use each. Read from live Docker state.',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('read')] as const,
      request: { params: idParam },
      responses: {
        200: { content: { 'application/json': { schema: StackEndpointsDto } }, description: 'Endpoints' },
        401: problemRes,
        404: problemRes,
      },
    }),
    (c) =>
      run(c, async () => {
        const ctx = c.get('orgCtx');
        return stackEndpointsToDto(stackEndpointsFor(ctx, await stackNameForId(ctx, c.req.param('id'))));
      }),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/stacks/{id}/connections',
      tags: [TAG],
      summary: 'Connect two apps over one private network',
      description:
        "Creates a private overlay for exactly this pair and rolls every app service of both onto it, aliased `<service>.<app>` — so this app reaches `api.billing:8080`. A third app sees neither; managed databases are not shared. Idempotent: an existing connection is a no-op. Policy: `stack.deploy` on both apps.",
      security: [{ bearerApiKey: [] }],
      middleware: [
        requireScope('write'),
        requireActionAll('stack.deploy', bothStacks, (b) => ({ peer: b.peer })),
      ] as const,
      request: {
        params: idParam,
        body: { content: { 'application/json': { schema: ConnectStackBody } } },
      },
      responses: {
        200: { content: { 'application/json': { schema: StackConnectionDto } }, description: 'Connected' },
        400: problemRes,
        403: problemRes,
        404: problemRes,
      },
    }),
    (c) =>
      run(c, async () => {
        const ctx = c.get('orgCtx');
        const stack = await stackNameForId(ctx, c.req.param('id'));
        const peer = await stackNameForId(ctx, c.req.valid('json').peer);
        return stackConnectionToDto(await connectStacks(ctx, { stack, peer }));
      }),
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/stacks/{id}/connections/{peer}',
      tags: [TAG],
      summary: 'Disconnect two apps',
      description:
        'Every service of both apps leaves the pair network and stops resolving the other. A peer that no longer exists is fine — the remaining side is detached. Policy: `stack.deploy` on both apps.',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write'), requireActionAll('stack.deploy', bothStacks)] as const,
      request: {
        params: z.object({
          id: z.string().openapi({ param: { name: 'id', in: 'path' } }),
          peer: z.string().openapi({ param: { name: 'peer', in: 'path' }, description: 'The other app: its stack id or name.' }),
        }),
      },
      responses: {
        200: { content: { 'application/json': { schema: StackConnectionDto } }, description: 'Disconnected' },
        400: problemRes,
        403: problemRes,
        404: problemRes,
      },
    }),
    (c) =>
      run(c, async () => {
        const ctx = c.get('orgCtx');
        const stack = await stackNameForId(ctx, c.req.param('id'));
        const peer = await stackNameForId(ctx, c.req.param('peer'));
        return stackConnectionToDto(await disconnectStacks(ctx, { stack, peer }));
      }),
  );
}
