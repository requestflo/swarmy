import { z } from 'zod';
import { authRegistry } from '@swarmy/auth';
import { adminProcedure, orgProcedure, router } from '../trpc';
import {
  deleteSsoProvider,
  listSsoProviders,
  upsertSsoProvider,
} from '../services/sso.service';

/**
 * Enterprise SSO (per-org OIDC/SAML). Reads are org-members; writes are
 * admin-only, audited (in the service), and trigger an `AuthRegistry.rebuild()`
 * so a new/edited OIDC provider goes live (registered with genericOAuth) with no
 * restart.
 */
export const ssoRouter = router({
  list: orgProcedure.query(({ ctx }) => listSsoProviders(ctx)),

  upsert: adminProcedure
    .input(
      z.object({
        id: z.string().optional(),
        providerId: z.string().min(2).max(40),
        protocol: z.enum(['oidc', 'saml']),
        domain: z.string().max(253).nullish(),
        issuer: z.string().url().nullish(),
        clientId: z.string().nullish(),
        clientSecret: z.string().optional(),
        enabled: z.boolean().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        mapping: z.record(z.string(), z.string()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await upsertSsoProvider(ctx, input);
      await authRegistry.rebuild();
      return result;
    }),

  delete: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const result = await deleteSsoProvider(ctx, input.id);
      await authRegistry.rebuild();
      return result;
    }),
});
