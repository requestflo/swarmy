import { z } from 'zod';
import { API_KEY_EXPIRIES, API_KEY_SCOPES } from '@swarmy/core';
import { adminProcedure, orgProcedure, router } from '../trpc';
import { abacProcedure } from '../abac';
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from '../services/apiKeys.service';
import {
  approveDeviceAuthorization,
  denyDeviceAuthorization,
  describeDeviceAuthorization,
} from '../services/cli-device.service';

const scopes = z.array(z.enum(API_KEY_SCOPES)).min(1);

export const apiKeysRouter = router({
  list: orgProcedure.query(({ ctx }) => listApiKeys(ctx)),

  // A preset (Read-only / Deploy / Admin) or raw scopes; optionally limited
  // to some apps; expiring in 30 d / 90 d / 1 y or never. Plaintext once.
  create: adminProcedure
    .input(
      z.object({
        name: z.string().min(1).max(80),
        preset: z.enum(['read', 'deploy', 'admin']).optional(),
        scopes: scopes.optional(),
        stackNames: z.array(z.string().min(1).max(128)).max(100).nullish(),
        expiry: z.enum(API_KEY_EXPIRIES).optional(),
      }),
    )
    .mutation(({ ctx, input }) => createApiKey(ctx, input)),

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
