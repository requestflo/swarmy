import { z } from 'zod';
import { CreateServiceInput, LogsInput, UpdateServiceInput } from '@swarmy/core';
import { orgProcedure, router } from '../trpc';
import {
  createService,
  getServiceDetail,
  inspectService,
  listServices,
  removeService,
  restartService,
  scaleService,
  setCanvasPosition,
  setScaleToZero,
  updateService,
  wakeService,
} from '../services/service.service';
import {
  getDeployStatus,
  getLatestServiceDeployStatus,
  watchDeployStatus,
} from '../services/deployment.service';
import { resolveManagerNode } from '../services/dispatch.service';
import { resolveServiceLogTarget } from '../services/live-resolve';

export const servicesRouter = router({
  list: orgProcedure
    .input(
      z
        .object({
          nodeId: z.string().optional(),
          stackId: z.string().optional(),
          status: z.string().optional(),
          search: z.string().optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) => listServices(ctx, input)),

  get: orgProcedure.input(z.object({ id: z.string() })).query(({ ctx, input }) =>
    getServiceDetail(ctx, input.id),
  ),

  // Full raw `docker service inspect` for the details/debug view (on-demand dispatch).
  inspect: orgProcedure
    .input(z.object({ id: z.string() }))
    .query(({ ctx, input }) => inspectService(ctx, input.id)),

  create: orgProcedure.input(CreateServiceInput).mutation(({ ctx, input }) => createService(ctx, input)),

  update: orgProcedure.input(UpdateServiceInput).mutation(({ ctx, input }) => updateService(ctx, input)),

  scale: orgProcedure
    .input(z.object({ id: z.string(), replicas: z.number().int().min(0).max(1000) }))
    .mutation(({ ctx, input }) => scaleService(ctx, input)),

  restart: orgProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => restartService(ctx, input.id)),

  remove: orgProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => removeService(ctx, input.id)),

  setScaleToZero: orgProcedure
    .input(
      z.object({
        id: z.string(),
        enabled: z.boolean(),
        targetReplicas: z.number().int().min(1).max(1000).optional(),
        idleSeconds: z.number().int().min(10).max(86400).optional(),
      }),
    )
    .mutation(({ ctx, input }) => setScaleToZero(ctx, input)),

  wake: orgProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => wakeService(ctx, input.id)),

  setCanvasPos: orgProcedure
    .input(z.object({ id: z.string(), x: z.number(), y: z.number() }))
    .mutation(({ ctx, input }) => setCanvasPosition(ctx, input)),

  deployStatus: orgProcedure
    .input(z.object({ serviceId: z.string() }))
    .query(({ ctx, input }) => getLatestServiceDeployStatus(ctx, input.serviceId)),

  deployStatusLive: orgProcedure
    .input(z.object({ deploymentId: z.string() }))
    .subscription(async function* ({ ctx, input, signal }) {
      const ac = signal ?? new AbortController().signal;
      yield* watchDeployStatus(ctx, input.deploymentId, ac);
    }),

  deployment: orgProcedure
    .input(z.object({ deploymentId: z.string() }))
    .query(({ ctx, input }) => getDeployStatus(ctx, input.deploymentId)),

  logsPage: orgProcedure
    .input(z.object({ id: z.string(), cursor: z.string().nullish(), limit: z.number().min(1).max(500).default(200) }))
    .query(() => ({ items: [], nextCursor: null as string | null })),

  logs: orgProcedure.input(LogsInput).subscription(async function* ({ ctx, input, signal }) {
    const ac = signal ?? new AbortController().signal;
    if (input.serviceId) {
      // Docker-direct: resolve the service name + a manager node from the live
      // inventory (no DB row) and stream `docker service logs` by name.
      const { serviceName, nodeId } = await resolveServiceLogTarget(ctx, input.serviceId);
      yield* ctx.hub.subscribeLogLines(
        nodeId,
        { action: 'start', target: { kind: 'service', service: serviceName }, tail: input.tail, follow: input.follow },
        ac,
      );
      return;
    }
    if (input.containerId) {
      // best-effort: stream from the first online node
      const node = await resolveManagerNode(ctx).catch(() => null);
      if (node) {
        yield* ctx.hub.subscribeLogLines(
          node.id,
          { action: 'start', target: { kind: 'container', containerId: input.containerId }, tail: input.tail, follow: input.follow },
          ac,
        );
      }
    }
  }),
});
