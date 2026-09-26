import { z } from 'zod';
import { orgProcedure, router } from '../trpc';
import { abacProcedure, abacProcedureAll, resolvePeerStack, resolveStack, resolveStackByName } from '../abac';
import {
  listStacks,
  parseCompose,
  redeployStack,
  removeStack,
  stackEndpointsFor,
} from '../services/stack.service';
import { connectStacks, disconnectStacks } from '../services/stack-links.service';
import { deployComposeTraced } from '../services/deploy-compose-traced';

export const stacksRouter = router({
  list: orgProcedure.query(({ ctx }) => listStacks(ctx)),
  /** Dry-run pasted compose: services it would create + translation warnings. */
  parseCompose: orgProcedure
    .input(z.object({ source: z.string().min(1).max(256_000) }))
    .mutation(({ input }) => parseCompose(input.source)),
  deployFromCompose: abacProcedure('stack.deploy', resolveStackByName)
    .input(
      z.object({
        name: z.string().regex(/^[a-z0-9][a-z0-9_.-]*$/),
        composeSource: z.string().min(1).max(256_000),
        /** Stack variables as `.env` text for `${VAR}` interpolation; omitted = keep the stored ones. */
        envSource: z.string().max(64_000).optional(),
        /** Override admission-policy violations (audited; block-level needs admin). */
        override: z.boolean().optional(),
      }),
    )
    // Traced: the result's `deployId` streams its progress (`deploys.events`).
    .mutation(({ ctx, input }) => deployComposeTraced(ctx, input)),
  redeploy: abacProcedure('stack.deploy', resolveStack)
    .input(
      z.object({
        id: z.string(),
        composeSource: z.string().optional(),
        envSource: z.string().max(64_000).optional(),
        override: z.boolean().optional(),
      }),
    )
    .mutation(({ ctx, input }) => redeployStack(ctx, input)),

  remove: abacProcedure('stack.remove', resolveStack)
    /** `deleteData`: also delete the app's volumes + its blueprint's secrets (default keeps both). */
    .input(z.object({ id: z.string(), deleteData: z.boolean().default(false) }))
    .mutation(({ ctx, input }) => removeStack(ctx, input.id, { deleteData: input.deleteData })),

  /**
   * Internal DNS names for an app's services and managed resources, and who
   * can use each ("reach this at `db:5432` from inside storefront").
   */
  endpoints: orgProcedure
    .input(z.object({ stack: z.string().min(1) }))
    .query(({ ctx, input }) => stackEndpointsFor(ctx, input.stack)),

  /** "Connect apps": one private overlay for exactly this pair (both directions). */
  // Both sides must be deployable by the caller: linking into a production
  // peer is a change to that peer.
  connect: abacProcedureAll('stack.deploy', [resolveStackByName, resolvePeerStack])
    .input(z.object({ stack: z.string().min(1), peer: z.string().min(1) }))
    .mutation(({ ctx, input }) => connectStacks(ctx, input)),

  disconnect: abacProcedureAll('stack.deploy', [resolveStackByName, resolvePeerStack])
    .input(z.object({ stack: z.string().min(1), peer: z.string().min(1) }))
    .mutation(({ ctx, input }) => disconnectStacks(ctx, input)),
});
