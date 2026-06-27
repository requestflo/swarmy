import { z } from 'zod';
import { ServiceModel } from '@swarmy/core/compose';
import { orgProcedure, router } from '../trpc';
import { exportCompose, parseCompose } from '../services/builder.service';

/**
 * GUI service-builder helpers: paste compose -> import (live, no DB) and
 * export the visual model back to a compose file. Pure translation; deploy still
 * flows through the existing `services`/`stacks` routers.
 */
export const builderRouter = router({
  parseCompose: orgProcedure
    .input(z.object({ source: z.string().min(1).max(256_000) }))
    .mutation(({ ctx, input }) => parseCompose(ctx, input.source)),

  exportCompose: orgProcedure
    .input(z.object({ models: z.array(ServiceModel).min(1) }))
    .mutation(({ ctx, input }) => exportCompose(ctx, input.models)),
});
