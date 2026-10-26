import { z } from 'zod';
import { orgProcedure } from '../trpc';
import { abacProcedure, resolveStackByName } from '../abac';
import { restoreApp } from '../services/appRestore.service';
import { appRestoreScope } from '../services/appRestore.scope';

/**
 * Whole-app restore (board 10), spread into `backups`: what it covers, and
 * the restore itself — every saved volume and managed database of an app back
 * to one moment, the app stopped once, each part with its own safety copy,
 * the done parts put back if one fails. `data.restore` on the app's stack,
 * the app's name typed back, one `app.restore` audit row listing every part.
 */
export const appRestoreProcedures = {
  appRestoreScope: orgProcedure
    .input(z.object({ stack: z.string().min(1) }))
    .query(({ ctx, input }) => appRestoreScope(ctx, input.stack)),

  restoreApp: abacProcedure('data.restore', resolveStackByName)
    .input(z.object({ stack: z.string().min(1), at: z.string().min(1), confirm: z.string() }))
    .mutation(({ ctx, input }) => restoreApp(ctx, input)),
};
