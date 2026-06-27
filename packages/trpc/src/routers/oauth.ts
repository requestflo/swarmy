import { z } from 'zod';
import { adminProcedure, orgProcedure, router } from '../trpc';
import {
  createOAuthClient,
  listOAuthClients,
  revokeOAuthClient,
  type OAuthScope,
} from '../services/oauth.service';

const scopes = z.array(z.enum(['read', 'write'])).min(1);

/**
 * Admin management of OAuth2 client-credentials clients. The actual token
 * issuance is a PUBLIC, unauthenticated endpoint (`POST /oauth/token`, served by
 * `apps/api/src/oauth.ts`) — only the lifecycle (create/list/revoke) is here.
 */
export const oauthRouter = router({
  list: orgProcedure.query(({ ctx }) => listOAuthClients(ctx)),

  create: adminProcedure
    .input(
      z.object({
        name: z.string().min(1).max(80),
        scopes: scopes.optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      createOAuthClient(ctx, { name: input.name, scopes: input.scopes as OAuthScope[] | undefined }),
    ),

  revoke: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => revokeOAuthClient(ctx, input.id)),
});
