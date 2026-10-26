import { z } from 'zod';
import { ImageSignaturesInput, RemoveTrustedKeyInput, RescanImageInput, SetRegistryPolicyInput, TrustedKeyInput } from '@swarmy/core';
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
import { stackSignatures } from '../services/image-signature.service';
import { addTrustedKey, removeTrustedKey } from '../services/trusted-keys.service';

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
  /** Keys besides the org's whose signatures count as signed (admin, audited). */
  addTrustedKey: adminProcedure
    .input(TrustedKeyInput)
    .mutation(({ ctx, input }) => addTrustedKey(ctx, input)),
  removeTrustedKey: adminProcedure
    .input(RemoveTrustedKeyInput)
    .mutation(({ ctx, input }) => removeTrustedKey(ctx, input.name)),
  /** Each part of an app and who signed the digest it runs (the canvas's sign chip). */
  signatures: orgProcedure
    .input(ImageSignaturesInput)
    .query(({ ctx, input }) => stackSignatures(ctx, input.stack)),
});
