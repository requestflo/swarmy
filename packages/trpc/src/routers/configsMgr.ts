import { z } from 'zod';
import {
  ApplyConfigVersionInput,
  AttachConfigInput,
  ConfigFamilyRefInput,
  ConfigRestartPreviewInput,
  CreateConfigFamilyInput,
  DetachConfigInput,
  GetConfigContentInput,
  NewConfigVersionInput,
} from '@swarmy/core';
import { adminProcedure, orgProcedure, router } from '../trpc';
import {
  applyConfigVersion,
  attachConfigToService,
  createConfigFamily,
  deleteConfigFamily,
  detachConfigFromService,
  getConfigContent,
  listConfigFamilies,
  newConfigVersion,
  pruneConfigVersions,
  restartPreview,
} from '../services/configsMgr.service';

/**
 * Configs manager (slice E2) — Docker config families (`swarmy.config.*`
 * labels, physical names `<family>__v<n>`), readable versioned content,
 * diff-driven edits and apply/rollback with restart previews. Content is
 * readable (config.inspect), unlike secrets.
 */
export const configsMgrRouter = router({
  /**
   * Families (versions + consumers + mount paths) and orphans — one live read.
   * Optional stack scope: keeps families attached to that stack's services,
   * plus every zero-attachment family (a fresh config never vanishes).
   */
  list: orgProcedure
    .input(z.object({ stack: z.string().optional() }).optional())
    .query(({ ctx, input }) => listConfigFamilies(ctx, input?.stack)),

  /** Decoded content of one version (current when unspecified) — feeds the diff. */
  content: orgProcedure
    .input(GetConfigContentInput)
    .query(({ ctx, input }) => getConfigContent(ctx, input)),

  /** Dry-run of apply: exactly which services restart, none touched. */
  restartPreview: orgProcedure
    .input(ConfigRestartPreviewInput)
    .query(({ ctx, input }) => restartPreview(ctx, input)),

  /** Create a family at v1. Nothing restarts until attach/apply. `stack` is an audit hint. */
  create: adminProcedure
    .input(CreateConfigFamilyInput.extend({ stack: z.string().optional() }))
    .mutation(({ ctx, input }) => createConfigFamily(ctx, input)),

  /** Save an edit as v(n+1) — consumers keep their version until apply. */
  newVersion: adminProcedure
    .input(NewConfigVersionInput)
    .mutation(({ ctx, input }) => newConfigVersion(ctx, input)),

  /** Redeploy every consumer onto a version (an older one = rollback). */
  applyVersion: adminProcedure
    .input(ApplyConfigVersionInput)
    .mutation(({ ctx, input }) => applyConfigVersion(ctx, input)),

  /** Mount the current version into a service at the family's stable path. */
  attach: adminProcedure
    .input(AttachConfigInput)
    .mutation(({ ctx, input }) => attachConfigToService(ctx, input)),

  detach: adminProcedure
    .input(DetachConfigInput)
    .mutation(({ ctx, input }) => detachConfigFromService(ctx, input)),

  /** Danger: remove every version. Refused while any service consumes it. */
  deleteFamily: adminProcedure
    .input(ConfigFamilyRefInput)
    .mutation(({ ctx, input }) => deleteConfigFamily(ctx, input)),

  /** Remove old, consumer-free versions (the current one always stays). */
  pruneVersions: adminProcedure
    .input(ConfigFamilyRefInput)
    .mutation(({ ctx, input }) => pruneConfigVersions(ctx, input)),
});
