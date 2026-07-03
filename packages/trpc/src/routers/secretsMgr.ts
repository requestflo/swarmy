import { z } from 'zod';
import {
  AttachSecretInput,
  CreateSecretFamilyInput,
  DetachSecretInput,
  RotateSecretInput,
  SecretFamilyRefInput,
} from '@swarmy/core';
import { adminProcedure, orgProcedure, router } from '../trpc';
import {
  attachSecretToService,
  createSecretFamily,
  deleteSecretFamily,
  detachSecretFromService,
  listSecretFamilies,
  pruneSecretVersions,
  rotateSecretFamily,
} from '../services/secretsMgr.service';

/**
 * Secrets manager (slice E1) — Docker secret families (`swarmy.secret.*`
 * labels, physical names `<family>__v<n>`), versions, rotation with consumer
 * redeploys, and a live usage map. Values are write-only: accepted on
 * create/rotate, never stored controller-side, never returned.
 */
export const secretsMgrRouter = router({
  /**
   * Families (versions + consumers) and unmanaged orphans — one live read.
   * Optional stack scope: keeps families attached to that stack's services,
   * plus every zero-attachment family (a fresh secret never vanishes).
   */
  list: orgProcedure
    .input(z.object({ stack: z.string().optional() }).optional())
    .query(({ ctx, input }) => listSecretFamilies(ctx, input?.stack)),

  /** Create a family at v1. The value never comes back. `stack` is an audit hint. */
  create: adminProcedure
    .input(CreateSecretFamilyInput.extend({ stack: z.string().optional() }))
    .mutation(({ ctx, input }) => createSecretFamily(ctx, input)),

  /** New version + redeploy every consumer onto it (services restart). */
  rotate: adminProcedure
    .input(RotateSecretInput)
    .mutation(({ ctx, input }) => rotateSecretFamily(ctx, input)),

  /** Mount the current version into a service at /run/secrets/<family>. */
  attach: adminProcedure
    .input(AttachSecretInput)
    .mutation(({ ctx, input }) => attachSecretToService(ctx, input)),

  detach: adminProcedure
    .input(DetachSecretInput)
    .mutation(({ ctx, input }) => detachSecretFromService(ctx, input)),

  /** Danger: remove every version. Refused while any service consumes it. */
  deleteFamily: adminProcedure
    .input(SecretFamilyRefInput)
    .mutation(({ ctx, input }) => deleteSecretFamily(ctx, input)),

  /** Remove old, consumer-free versions (the current one always stays). */
  pruneVersions: adminProcedure
    .input(SecretFamilyRefInput)
    .mutation(({ ctx, input }) => pruneSecretVersions(ctx, input)),
});
