import { z } from 'zod';
import {
  CreateInboundEndpointInput,
  InboundDeliveriesInput,
  InboundDeliveryRefInput,
  InboundEndpointRefInput,
  UpdateInboundEndpointInput,
} from '@swarmy/core';
import { orgProcedure, router } from '../trpc';
import {
  createEndpoint,
  deleteOldDeliveries,
  getDelivery,
  listDeliveries,
  listEndpoints,
  overview,
  removeEndpoint,
  replayDelivery,
  updateEndpoint,
} from '../services/inboundWebhooks.service';

/**
 * Inbound webhook gateway (slice B4) — public endpoints, verified deliveries,
 * retry/replay/DLQ. The public receiver lives at `POST /hooks/i/<org>/<slug>`
 * (apps/api/src/inbound-hooks.ts); delivery to queue/forward targets happens in
 * the `inbound-webhook-dispatch` worker. Stack-scoped IA: list/overview take an
 * optional `stack`; endpoints can carry a custom `domain` (served at the edge)
 * plus handlebars-style transform/response templates ({{body}}, {{headers.x}},
 * {{json.path}}, {{slug}}, {{deliveryId}}) applied by the receiver + worker.
 */

/** Optional stack scope for list/overview procedures (no input = org-wide). */
const StackScopeInput = z.object({ stack: z.string().min(1).optional() }).optional();

const TEMPLATE_MAX = 16_384;

/** Stack + DNS exposure + templating fields riding next to the core inputs. */
const endpointExtras = {
  /** Custom domain — '' clears it; validated/normalized server-side. */
  domain: z.string().max(253).optional(),
  /** Body transform applied before delivery; '' clears (pass-through). */
  transformTemplate: z.string().max(TEMPLATE_MAX).optional(),
  /** Templated 202 ack body; '' clears (default `{ok:true}` ack). */
  responseTemplate: z.string().max(TEMPLATE_MAX).optional(),
};

const CreateEndpointStackInput = CreateInboundEndpointInput.extend({
  stackName: z.string().min(1).max(63).optional(),
  ...endpointExtras,
});

const UpdateEndpointStackInput = UpdateInboundEndpointInput.extend(endpointExtras);

const DeliveriesStackInput = InboundDeliveriesInput.extend({
  stack: z.string().min(1).optional(),
});

export const inboundWebhooksRouter = router({
  /** Counts for the Webhooks hero (endpoints, 24h volume, pending, dead). */
  overview: orgProcedure
    .input(StackScopeInput)
    .query(({ ctx, input }) => overview(ctx, input?.stack)),

  /** Every endpoint with its public URL, custom domain, target and 24h volume. */
  listEndpoints: orgProcedure
    .input(StackScopeInput)
    .query(({ ctx, input }) => listEndpoints(ctx, input?.stack)),

  /** Create an endpoint (slug org-unique; secret vault-encrypted; audited). */
  createEndpoint: orgProcedure
    .input(CreateEndpointStackInput)
    .mutation(({ ctx, input }) => createEndpoint(ctx, input)),

  /** Update name/verify/target/domain/templates — slug is immutable (audited). */
  updateEndpoint: orgProcedure
    .input(UpdateEndpointStackInput)
    .mutation(({ ctx, input }) => updateEndpoint(ctx, input)),

  /** Delete an endpoint and its delivery history (audited). */
  removeEndpoint: orgProcedure
    .input(InboundEndpointRefInput)
    .mutation(({ ctx, input }) => removeEndpoint(ctx, input.id)),

  /** Deliveries feed (filter by endpoint/status/stack; cursor-paginated). */
  deliveries: orgProcedure
    .input(DeliveriesStackInput)
    .query(({ ctx, input }) => listDeliveries(ctx, input)),

  /** Payload inspector: one delivery with captured headers + raw body. */
  delivery: orgProcedure
    .input(InboundDeliveryRefInput)
    .query(({ ctx, input }) => getDelivery(ctx, input.id)),

  /** Re-queue a delivery for the dispatch worker (attempt log kept; audited). */
  replay: orgProcedure
    .input(InboundDeliveryRefInput)
    .mutation(({ ctx, input }) => replayDelivery(ctx, input.id)),

  /** Delete deliveries older than each endpoint's retentionDays (audited). */
  pruneOld: orgProcedure.mutation(({ ctx }) => deleteOldDeliveries(ctx)),
});
