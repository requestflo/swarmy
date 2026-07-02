import { z } from 'zod';
import { RescanImageInput, SetRegistryPolicyInput } from '@swarmy/core';
import { adminProcedure, orgProcedure, router } from '../trpc';
import {
  enableSigning,
  getPolicy,
  listScans,
  rescan,
  scanDetail,
  setPolicy,
  signingStatus,
} from '../services/registryPolicy.service';

/**
 * Registry policy — image CVE scans (trivy), cosign signing, admission toggles
 * (slice D3). Reads are org-scoped; policy/signing mutations are admin-only and
 * audited in the service layer. The cosign private key never crosses this
 * boundary — only the public key + an `enabled` flag do.
 */
export const registryPolicyRouter = router({
  // ── Policy toggles ──
  getPolicy: orgProcedure.query(({ ctx }) => getPolicy(ctx)),
  setPolicy: adminProcedure
    .input(SetRegistryPolicyInput)
    .mutation(({ ctx, input }) => setPolicy(ctx, input)),

  // ── Scans ──
  listScans: orgProcedure
    .input(
      z
        .object({
          imageRef: z.string().optional(),
          limit: z.number().int().min(1).max(200).optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) => listScans(ctx, input)),
  scanDetail: orgProcedure
    .input(z.object({ id: z.string() }))
    .query(({ ctx, input }) => scanDetail(ctx, input.id)),
  rescan: adminProcedure
    .input(RescanImageInput)
    .mutation(({ ctx, input }) => rescan(ctx, input.imageRef)),

  // ── Signing ──
  signingStatus: orgProcedure.query(({ ctx }) => signingStatus(ctx)),
  enableSigning: adminProcedure.mutation(({ ctx }) => enableSigning(ctx)),
});
