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
 * the `inbound-webhook-dispatch` worker.
 */
export const inboundWebhooksRouter = router({
  /** Counts for the Webhooks page hero (endpoints, 24h volume, pending, dead). */
  overview: orgProcedure.query(({ ctx }) => overview(ctx)),

  /** Every endpoint with its public URL, verify kind, target and 24h volume. */
  listEndpoints: orgProcedure.query(({ ctx }) => listEndpoints(ctx)),

  /** Create an endpoint (slug org-unique; secret vault-encrypted; audited). */
  createEndpoint: orgProcedure
    .input(CreateInboundEndpointInput)
    .mutation(({ ctx, input }) => createEndpoint(ctx, input)),

  /** Update name/verify/target/retention — slug is immutable (audited). */
  updateEndpoint: orgProcedure
    .input(UpdateInboundEndpointInput)
    .mutation(({ ctx, input }) => updateEndpoint(ctx, input)),

  /** Delete an endpoint and its delivery history (audited). */
  removeEndpoint: orgProcedure
    .input(InboundEndpointRefInput)
    .mutation(({ ctx, input }) => removeEndpoint(ctx, input.id)),

  /** Deliveries feed (filter by endpoint/status; cursor-paginated, newest first). */
  deliveries: orgProcedure
    .input(InboundDeliveriesInput)
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
