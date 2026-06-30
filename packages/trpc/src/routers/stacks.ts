import { z } from 'zod';
import { orgProcedure, router } from '../trpc';
import {
  addServiceToStack,
  deployFromCompose,
  getStack,
  listStacks,
  redeployStack,
  removeStack,
} from '../services/stack.service';

export const stacksRouter = router({
  list: orgProcedure.query(({ ctx }) => listStacks(ctx)),

  get: orgProcedure.input(z.object({ id: z.string() })).query(({ ctx, input }) => getStack(ctx, input.id)),

  deployFromCompose: orgProcedure
    .input(
      z.object({
        name: z.string().regex(/^[a-z0-9][a-z0-9_.-]*$/),
        composeSource: z.string().min(1).max(256_000),
      }),
    )
    .mutation(({ ctx, input }) => deployFromCompose(ctx, input)),

  // Contextual deploy: add a single app INTO an existing stack (stamped with the
  // stack-namespace label so it lands in the same Project frame on the canvas).
  addServiceToStack: orgProcedure
    .input(
      z.object({
        stack: z.string().min(1),
        name: z.string().regex(/^[a-z0-9][a-z0-9_.-]*$/),
        image: z.string().min(1),
        ports: z
          .array(
            z.object({
              target: z.number().int().positive(),
              published: z.number().int().positive().optional(),
              protocol: z.enum(['tcp', 'udp']).optional(),
            }),
          )
          .optional(),
        env: z.record(z.string()).optional(),
        replicas: z.number().int().min(1).max(1000).optional(),
      }),
    )
    .mutation(({ ctx, input }) => addServiceToStack(ctx, input)),

  redeploy: orgProcedure
    .input(z.object({ id: z.string(), composeSource: z.string().optional() }))
    .mutation(({ ctx, input }) => redeployStack(ctx, input)),

  remove: orgProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => removeStack(ctx, input.id)),
});
