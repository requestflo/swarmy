import { z } from 'zod';
import { adminProcedure, orgProcedure, router } from '../trpc';
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  type ApiKeyScope,
} from '../services/apiKeys.service';

const scopes = z.array(z.enum(['read', 'write'])).min(1);

export const apiKeysRouter = router({
  list: orgProcedure.query(({ ctx }) => listApiKeys(ctx)),

  create: adminProcedure
    .input(
      z.object({
        name: z.string().min(1).max(80),
        scopes: scopes.optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      createApiKey(ctx, { name: input.name, scopes: input.scopes as ApiKeyScope[] | undefined }),
    ),

  revoke: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => revokeApiKey(ctx, input.id)),
});
