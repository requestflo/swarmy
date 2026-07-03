import { z } from 'zod';
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

/** Optional stack scope for list/options reads (stack-first IA convention). */
const StackScopeInput = z.object({ stack: z.string().min(1).max(255).optional() }).optional();

/**
 * Status pages (slice C5) — the settings surface behind the stack workspace's
 * Observability tab. The PUBLIC snapshot is intentionally NOT here: anonymous
 * visitors hit `GET /status/<slug>.json` (apps/api/src/status-public.ts, no
 * auth); the `preview` procedure below is the authed, org-scoped view of the
 * same snapshot for the settings surface and demo mode.
 */
export const statusPagesRouter = router({
  /** Aggregates for the page hero (pages / enabled / components / samples 24h). */
  overview: orgProcedure.query(({ ctx }) => overview(ctx)),

  /** The org's status pages, newest first — optionally scoped to one stack. */
  list: orgProcedure
    .input(StackScopeInput)
    .query(({ ctx, input }) => listPages(ctx, input?.stack)),

  /**
   * Pickable components — live services, db/cache clusters, regions, ingress.
   * With a `stack`, only that stack's services and clusters are offered.
   */
  componentOptions: orgProcedure
    .input(StackScopeInput)
    .query(({ ctx, input }) => componentOptions(ctx, input?.stack)),

  /** The public snapshot (authed preview of `GET /status/<slug>.json`). */
  preview: orgProcedure
    .input(PublicStatusInput)
    .query(({ ctx, input }) => publicStatus(ctx, input.slug)),

  /** Create a page (slug is global-unique — it becomes `/s/<slug>`). */
  create: orgProcedure
    .input(CreateStatusPageInput.extend({ stackName: z.string().min(1).max(255).optional() }))
    .mutation(({ ctx, input }) => createPage(ctx, input)),

  /** Update title/slug/domain/components/toggles (`stackName: null` detaches). */
  update: orgProcedure
    .input(
      UpdateStatusPageInput.extend({ stackName: z.string().min(1).max(255).nullable().optional() }),
    )
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
