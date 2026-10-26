/**
 * Branch previews' rules (board 68), spread into `appsRouter` as
 * `apps.setPreviewRules`. Saving is for an app whose swarmy.yaml has no
 * `previews:` block — the rules then live on the production stack's
 * services; when the file sets them, the file decides and this refuses.
 */
import { z } from 'zod';
import { PreviewsSchema } from '@swarmy/app-config';
import { abacProcedure, resolveStackByName } from '../abac';
import { setPreviewRules } from '../services/apps/preview-rules.service';

export const appPreviewProcedures = {
  /**
   * Save (or clear, `rules: null`) the preview rules on the production stack
   * `stack`: which branches and PRs get previews, how long they're kept, when
   * they sleep, what data they start with and how big they may get.
   * `service.configure` on that stack; audited `app.previews.rules`.
   */
  setPreviewRules: abacProcedure('service.configure', resolveStackByName)
    .input(z.object({ stack: z.string().min(1).max(100), rules: PreviewsSchema.nullable() }))
    .mutation(({ ctx, input }) => setPreviewRules(ctx, input)),
};
