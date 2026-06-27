import { z } from 'zod';
import { adminProcedure, orgProcedure, router } from '../trpc';
import {
  enqueueEvent,
  listEndpoints,
  registerEndpoint,
  removeEndpoint,
  setEndpointActive,
} from '../services/webhooks-out.service';

/**
 * Admin management of OUTBOUND webhook endpoints (distinct from the inbound git
 * webhook receiver). `test` enqueues a `ping` delivery against all subscribed
 * endpoints so an operator can confirm wiring end-to-end via the dispatch worker.
 */
export const webhooksOutRouter = router({
  list: orgProcedure.query(({ ctx }) => listEndpoints(ctx)),

  register: adminProcedure
    .input(
      z.object({
        url: z.string().url(),
        events: z.array(z.string().min(1)).min(1),
        secret: z.string().min(8).max(200).optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      registerEndpoint(ctx, { url: input.url, events: input.events, secret: input.secret }),
    ),

  setActive: adminProcedure
    .input(z.object({ id: z.string(), active: z.boolean() }))
    .mutation(({ ctx, input }) => setEndpointActive(ctx, input.id, input.active)),

  remove: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => removeEndpoint(ctx, input.id)),

  test: adminProcedure
    .input(z.object({ eventType: z.string().min(1).default('ping') }).optional())
    .mutation(async ({ ctx, input }) => {
      const eventType = input?.eventType ?? 'ping';
      const ids = await enqueueEvent(ctx.db, ctx.activeOrgId, eventType, {
        test: true,
        eventType,
        at: new Date().toISOString(),
      });
      return { enqueued: ids.length, deliveryIds: ids };
    }),
});
