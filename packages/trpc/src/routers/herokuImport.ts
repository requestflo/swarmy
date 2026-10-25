import { TRPCError } from '@trpc/server';
import { HerokuImportCopyInput, HerokuImportDeployInput, HerokuImportPlanInput } from '@swarmy/core';
import { orgProcedure, router } from '../trpc';
import { abacProcedure, resolveStackByName } from '../abac';
import { copyHerokuDatabase } from '../services/heroku-import/copy.service';
import { deployHerokuImport } from '../services/heroku-import/deploy.service';
import { planHerokuImport } from '../services/heroku-import/plan.service';

const FORBIDDEN = (): TRPCError => new TRPCError({ code: 'FORBIDDEN', message: 'requires admin or owner' });

/**
 * Import from Heroku: plan → Deploy → copy the data. Every call is a
 * mutation so a Heroku token (or pasted config with its values) travels in
 * a request body, never a URL; none of it is stored.
 */
export const herokuImportRouter = router({
  /** Read the Heroku app and say what it becomes. Changes nothing anywhere. Audited `heroku.import.plan`. */
  plan: orgProcedure.input(HerokuImportPlanInput).mutation(({ ctx, input }) => planHerokuImport(ctx, input)),

  /** Start the app's data stores and seal its secrets (the push of swarmy.yaml deploys the services). Audited `heroku.import.deploy`. */
  deploy: abacProcedure('stack.deploy', resolveStackByName)
    // Deploy seals secrets and copy reads a database password: admins and owners, as secrets.create.
    .use(({ ctx, next }) => (ctx.membership.role === 'member' ? Promise.reject(FORBIDDEN()) : next()))
    .input(HerokuImportDeployInput)
    .mutation(({ ctx, input }) => deployHerokuImport(ctx, input)),

  /** One-shot copy of a Heroku Postgres into the new, empty managed one; `confirm` = `<stack>/<cluster>`. Audited `heroku.import.copy`. */
  copyDatabase: abacProcedure('data.restore', resolveStackByName)
    .use(({ ctx, next }) => (ctx.membership.role === 'member' ? Promise.reject(FORBIDDEN()) : next()))
    .input(HerokuImportCopyInput)
    .mutation(({ ctx, input }) => copyHerokuDatabase(ctx, input)),
});
