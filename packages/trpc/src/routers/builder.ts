import { z } from 'zod';
import { ServiceModel } from '@swarmy/core/compose';
import { orgProcedure, router } from '../trpc';
import {
  deployFromModel,
  exportCompose,
  exportServiceSpec,
  parseCompose,
} from '../services/builder.service';

/**
 * GUI service-builder helpers: paste compose -> import (live, no DB), export the
 * visual model back to compose, view the raw wire spec, and the FULL-FIDELITY
 * deploy path (`deploy`) that projects the complete ServiceModel — placement,
 * mounts, labels, healthcheck, resources, configs/secrets — through to the
 * agent (unlike the lossy `services.create` subset).
 */
export const builderRouter = router({
  parseCompose: orgProcedure
    .input(z.object({ source: z.string().min(1).max(256_000) }))
    .mutation(({ ctx, input }) => parseCompose(ctx, input.source)),

  exportCompose: orgProcedure
    .input(z.object({ models: z.array(ServiceModel).min(1) }))
    .mutation(({ ctx, input }) => exportCompose(ctx, input.models)),

  exportServiceSpec: orgProcedure
    .input(z.object({ model: ServiceModel }))
    .query(({ input }) => exportServiceSpec(input.model)),

  deploy: orgProcedure
    .input(z.object({ model: ServiceModel, nodeId: z.string().optional() }))
    .mutation(({ ctx, input }) => deployFromModel(ctx, input)),
});
