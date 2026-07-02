import {
  CreateStatusPageInput,
  PublicStatusInput,
  SetStatusPageEnabledInput,
  StatusPageRefInput,
  UpdateStatusPageInput,
} from '@swarmy/core';
import { orgProcedure, router } from '../trpc';
import {
  componentOptions,
  createPage,
  listPages,
  overview,
  publicStatus,
  removePage,
  setEnabled,
  updatePage,
} from '../services/statusPages.service';

/**
 * Status pages (slice C5) — the settings surface behind `/status-pages`.
 * The PUBLIC snapshot is intentionally NOT here: anonymous visitors hit
 * `GET /status/<slug>.json` (apps/api/src/status-public.ts, no auth); the
 * `preview` procedure below is the authed, org-scoped view of the same
 * snapshot for the settings page and demo mode.
 */
export const statusPagesRouter = router({
  /** Aggregates for the page hero (pages / enabled / components / samples 24h). */
  overview: orgProcedure.query(({ ctx }) => overview(ctx)),

  /** The org's status pages, newest first. */
  list: orgProcedure.query(({ ctx }) => listPages(ctx)),

  /** Pickable components — live services, db/cache clusters, regions, ingress. */
  componentOptions: orgProcedure.query(({ ctx }) => componentOptions(ctx)),

  /** The public snapshot (authed preview of `GET /status/<slug>.json`). */
  preview: orgProcedure
    .input(PublicStatusInput)
    .query(({ ctx, input }) => publicStatus(ctx, input.slug)),

  /** Create a page (slug is global-unique — it becomes `/s/<slug>`). */
  create: orgProcedure
    .input(CreateStatusPageInput)
    .mutation(({ ctx, input }) => createPage(ctx, input)),

  /** Update title/slug/domain/components/toggles. */
  update: orgProcedure
    .input(UpdateStatusPageInput)
    .mutation(({ ctx, input }) => updatePage(ctx, input)),

  /** Delete a page and its uptime history. */
  remove: orgProcedure
    .input(StatusPageRefInput)
    .mutation(({ ctx, input }) => removePage(ctx, input)),

  /** Take a page live / dark without losing history. */
  setEnabled: orgProcedure
    .input(SetStatusPageEnabledInput)
    .mutation(({ ctx, input }) => setEnabled(ctx, input)),
});
