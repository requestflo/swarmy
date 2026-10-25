/**
 * Environments of a git app (boards Environments · AppVariables): the
 * shared-vs-override layers swarmy.yaml defines (read-only, masked), Clone as
 * a new environment, filling a clone's secret slots (write-only) and removing
 * a clone. Spread into `appsRouter`, so the paths are `apps.envLayers` /
 * `apps.cloneEnvironment` / `apps.setEnvironmentSecret` / `apps.removeEnvironment`.
 */
import { z } from 'zod';
import { ENV_NAME_RE } from '@swarmy/app-config';
import { orgProcedure } from '../trpc';
import { abacProcedure, resolveStackByName } from '../abac';
import { planCommit } from '../services/apps.service';
import { cloneEnvironment } from '../services/apps/clone';
import { readEnvLayers } from '../services/apps/env-layers';
import { setEnvironmentSecret } from '../services/apps/env-secrets';
import { removeEnvironment } from '../services/apps/remove-env';
import { realRemoveEnvOps } from '../services/apps/remove-env-ops';

const stack = z.string().min(1).max(100);

export const appEnvironmentProcedures = {
  /** Every app-wide variable per environment with its origin; secrets masked. Null = not a git app. */
  envLayers: orgProcedure.input(z.object({ stack })).query(({ ctx, input }) => readEnvLayers(ctx, input)),

  /**
   * Clone the environment `stack` runs as a new long-lived environment from
   * `branch` (its own stack, never a preview). `stack.deploy` on the app's
   * stack; audited `app.environment.clone`. Secrets are never copied.
   */
  cloneEnvironment: abacProcedure('stack.deploy', resolveStackByName)
    .input(
      z.object({
        stack,
        name: z.string().regex(ENV_NAME_RE, 'lowercase letters, digits and - only; max 20'),
        branch: z.string().min(1).max(200),
        database: z.boolean().default(false),
        mask: z.boolean().default(false),
      }),
    )
    .mutation(({ ctx, input }) => cloneEnvironment(ctx, input, planCommit)),

  /** Fill (or rotate) one of a cloned environment's secret slots. Write-only: the value never comes back. */
  setEnvironmentSecret: abacProcedure('service.configure', resolveStackByName)
    .input(z.object({ stack, family: z.string().min(1).max(56), value: z.string().min(1).max(100_000) }))
    .mutation(({ ctx, input }) => setEnvironmentSecret(ctx, input)),

  /**
   * Remove a cloned environment: its stack torn down like a preview (its
   * addresses with it), its data (databases + volumes) kept and marked
   * orphaned (default) or deleted, its own secrets removed, its marker
   * dropped. Refused for production and swarmy.yaml environments.
   * `stack.remove` on the environment's stack (+ `data.destroy` per deleted
   * database); audited `app.environment.remove`.
   */
  removeEnvironment: abacProcedure('stack.remove', resolveStackByName)
    .input(z.object({ stack, confirm: z.string().max(200), data: z.enum(['keep', 'delete']).default('keep') }))
    .mutation(({ ctx, input }) => removeEnvironment(ctx, input, realRemoveEnvOps(ctx))),
};
