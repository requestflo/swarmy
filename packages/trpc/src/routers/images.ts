import { z } from 'zod';
import { orgProcedure, router } from '../trpc';
import { listTags, searchImages } from '../services/images.service';

/**
 * Docker Hub autocomplete proxy for the service builder. Best-effort: handlers
 * return `[]` on failure so the UI degrades to a plain text input.
 */
export const imagesRouter = router({
  search: orgProcedure
    .input(z.object({ query: z.string().max(200) }))
    .query(({ input }) => searchImages(input.query)),

  tags: orgProcedure
    .input(z.object({ image: z.string().min(1).max(255) }))
    .query(({ input }) => listTags(input.image)),
});
