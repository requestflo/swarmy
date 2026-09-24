import { z } from 'zod';
import { orgProcedure, router } from '../trpc';
import { listAllTags, searchAllImages } from '../services/images.service';

/**
 * Image autocomplete for the service builder: the built-in registry first,
 * Docker Hub second. Best-effort: handlers return `[]` on failure so the UI
 * degrades to a plain text input.
 */
export const imagesRouter = router({
  search: orgProcedure
    .input(z.object({ query: z.string().max(200) }))
    .query(({ ctx, input }) => searchAllImages({ db: ctx.db, hub: ctx.hub, orgId: ctx.activeOrgId }, input.query)),

  tags: orgProcedure
    .input(z.object({ image: z.string().min(1).max(255) }))
    .query(({ ctx, input }) => listAllTags({ db: ctx.db, hub: ctx.hub, orgId: ctx.activeOrgId }, input.image)),
});
