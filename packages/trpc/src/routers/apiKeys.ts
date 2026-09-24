import { z } from 'zod';
import { adminProcedure, orgProcedure, router } from '../trpc';
import { abacProcedure } from '../abac';
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  type ApiKeyScope,
} from '../services/apiKeys.service';
import {
  approveDeviceAuthorization,
  denyDeviceAuthorization,
  describeDeviceAuthorization,
} from '../services/cli-device.service';

const scopes = z.array(z.enum(['read', 'write', 'secrets.read'])).min(1);

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

  revoke: abacProcedure('token.revoke')
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => revokeApiKey(ctx, input.id)),

  // ── `swarmy login` (device authorization) — the dashboard's /device page ──
  // Approving mints an API key as the signed-in member. Members may grant
  // read; write/secrets.read need admin (checked in the service).
  cliRequest: orgProcedure
    .input(z.object({ userCode: z.string().min(4).max(20) }))
    .query(({ ctx, input }) => describeDeviceAuthorization(ctx, input.userCode)),

  cliApprove: orgProcedure
    .input(z.object({ userCode: z.string().min(4).max(20), scopes: scopes.optional() }))
    .mutation(({ ctx, input }) => approveDeviceAuthorization(ctx, input)),

  cliDeny: orgProcedure
    .input(z.object({ userCode: z.string().min(4).max(20) }))
    .mutation(({ ctx, input }) => denyDeviceAuthorization(ctx, input.userCode)),
});
