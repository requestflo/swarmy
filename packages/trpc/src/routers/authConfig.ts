import { z } from 'zod';
import { authRegistry } from '@swarmy/auth';
import { adminProcedure, orgProcedure, router } from '../trpc';
import { listProviders, setProvider } from '../services/authConfig.service';

/**
 * Admin-gated auth-provider configuration. Reads are org-members; writes are
 * admin-only, audited (in the service), and trigger an `AuthRegistry.rebuild()`
 * so a toggled provider goes live with no restart.
 */
export const authConfigRouter = router({
  listProviders: orgProcedure.query(({ ctx }) => listProviders(ctx)),

  setProvider: adminProcedure
    .input(
      z.object({
        type: z.string(),
        enabled: z.boolean().optional(),
        clientId: z.string().optional(),
        clientSecret: z.string().optional(),
        scopes: z.array(z.string()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await setProvider(ctx, input);
      // Atomically swap in a fresh Better Auth instance reflecting the new config.
      await authRegistry.rebuild();
      return result;
    }),
});
