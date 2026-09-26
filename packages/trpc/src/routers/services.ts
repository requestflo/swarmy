import { z } from 'zod';
import {
  CreateServiceInput,
  LogsInput,
  SecretVarRefInput,
  SetSecretVarInput,
  UpdateServiceInput,
} from '@swarmy/core';
import { orgProcedure, router } from '../trpc';
import { abacProcedure, resolveNewService, resolveService } from '../abac';
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
  getLatestServiceDeployStatus,
} from '../services/deployment.service';
import { resolveManagerNode } from '../services/dispatch.service';
import { canReadSecrets, redactEnvRecord, redactInspect, restoreRedactedEnv } from '../services/secret-redact';
import {
  listSecretVars,
  removeSecretVar,
  revealSecretVar,
  setSecretVar,
} from '../services/app-secrets.service';
import { resolveServiceLogTarget } from '../services/live-resolve';
import { serviceUsage } from '../services/service-usage';

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

  // Secret-looking env values are masked unless the caller holds
  // `secrets.read` on this service (the same filter as `inspect`).
  get: orgProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const detail = getServiceDetail(ctx, input.id);
    const resource = await resolveService(ctx, { id: detail.id });
    return (await canReadSecrets(ctx, resource)) ? detail : { ...detail, env: redactEnvRecord(detail.env) };
  }),

  // Full raw `docker service inspect` for the details/debug view (on-demand
  // dispatch). Secret-looking env values are masked unless the caller holds
  // `secrets.read` on this service.
  inspect: orgProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const [inspect, resource] = await Promise.all([inspectService(ctx, input.id), resolveService(ctx, input)]);
      return (await canReadSecrets(ctx, resource)) ? inspect : redactInspect(inspect);
    }),

  /** What the copies use right now (per copy, across servers); null until one reports. */
  usage: orgProcedure.input(z.object({ id: z.string() })).query(({ ctx, input }) => serviceUsage(ctx, input.id)),

  create: abacProcedure('service.deploy', resolveNewService).input(CreateServiceInput).mutation(({ ctx, input }) => createService(ctx, input)),

  update: abacProcedure('service.configure', resolveService)
    .input(UpdateServiceInput)
    .mutation(({ ctx, input }) =>
      // `get` masks secret-looking values for callers without `secrets.read`;
      // never deploy that mask back over the real value.
      updateService(ctx, input.env ? { ...input, env: restoreRedactedEnv(input.env, getServiceDetail(ctx, input.id).env) } : input),
    ),

  // ── Secret app variables (Docker secrets; write-only) ──────────────────────
  /** Metadata only (key, delivery, version, set by/at) — never a value. */
  secretVars: orgProcedure
    .input(z.object({ id: z.string() }))
    .query(({ ctx, input }) => listSecretVars(ctx, input.id)),

  /** Create/rotate one secret var (new Docker secret version → rolling update). */
  setSecretVar: abacProcedure('service.configure', resolveService)
    .input(SetSecretVarInput)
    .mutation(({ ctx, input }) => setSecretVar(ctx, input)),

  removeSecretVar: abacProcedure('service.configure', resolveService)
    .input(SecretVarRefInput)
    .mutation(({ ctx, input }) => removeSecretVar(ctx, input)),

  /**
   * Reveal a value — gated on `secrets.read` inside the service (authorize →
   * audited permit/deny) plus a `secrets.reveal` audit row per call. A
   * mutation so it is never cached, prefetched or retried by the client.
   */
  revealSecretVar: orgProcedure
    .input(SecretVarRefInput)
    .mutation(({ ctx, input }) => revealSecretVar(ctx, input)),

  scale: abacProcedure('service.scale', resolveService)
    .input(z.object({ id: z.string(), replicas: z.number().int().min(0).max(1000) }))
    .mutation(({ ctx, input }) => scaleService(ctx, input)),

  restart: abacProcedure('service.restart', resolveService)
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => restartService(ctx, input.id)),

  remove: abacProcedure('service.remove', resolveService)
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => removeService(ctx, input.id)),

  setScaleToZero: abacProcedure('service.configure', resolveService)
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
