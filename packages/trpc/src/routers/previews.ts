import {
  CreateManualPreviewInput,
  DestroyPreviewInput,
  PreviewRepoRefInput,
  SetPreviewSettingsInput,
} from '@swarmy/core';
import { orgProcedure, router } from '../trpc';
import {
  createManualPreview,
  destroyPreview,
  getPreviewSettings,
  listPreviews,
  setPreviewSettings,
} from '../services/previews.service';

/**
 * PR preview environments (slice D4) — ephemeral `pr<N>-<repo-short>` stacks,
 * pure Docker-truth (`swarmy.preview.*` labels). Settings live on the repo
 * (`GitRepo.previewsJson`); the webhook receiver + `preview-reconcile` worker
 * drive the lifecycle, this router serves the dashboard.
 */
export const previewsRouter = router({
  /** Every live preview in the org — an inventory scan, never the DB. */
  list: orgProcedure.query(({ ctx }) => listPreviews(ctx)),

  /** One repo's preview settings (enabled / base domain / TTL / teardown). */
  getSettings: orgProcedure
    .input(PreviewRepoRefInput)
    .query(({ ctx, input }) => getPreviewSettings(ctx, input.repoId)),

  /** Save a repo's preview settings (audited). */
  setSettings: orgProcedure
    .input(SetPreviewSettingsInput)
    .mutation(({ ctx, input }) => setPreviewSettings(ctx, input)),

  /** Build + deploy a preview for a branch without a PR (audited). */
  createManual: orgProcedure
    .input(CreateManualPreviewInput)
    .mutation(({ ctx, input }) => createManualPreview(ctx, input)),

  /** Tear one preview down now — services, secrets, route (audited). */
  destroy: orgProcedure
    .input(DestroyPreviewInput)
    .mutation(({ ctx, input }) => destroyPreview(ctx, input)),
});
