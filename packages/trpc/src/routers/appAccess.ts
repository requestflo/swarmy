import { z } from 'zod';
import { router } from '../trpc';
import { abacProcedure, resolveStackByName } from '../abac';
import {
  getAppAccess,
  listEndUsers,
  setAppAccessRules,
  setEndUserDisabled,
  setRequireLogin,
} from '../services/app-access-admin.service';

const stack = z.string().min(1).max(120);

/**
 * The app Access panel (dev-platform §2): "Require login" (identity-aware
 * proxy), who can enter (ABAC `app.access` rules on the stack) and — for apps
 * with `auth:` in swarmy.yaml — the app's own end users.
 */
export const appAccessRouter = router({
  get: abacProcedure('stack.read', resolveStackByName)
    .input(z.object({ stack }))
    .query(({ ctx, input }) => getAppAccess(ctx, input.stack)),

  /** Gate every route of the app (or the listed ones) behind swarmy sign-in. */
  setRequireLogin: abacProcedure('ingress.write', resolveStackByName)
    .input(z.object({ stack, on: z.boolean(), routeIds: z.array(z.string()).optional() }))
    .mutation(({ ctx, input }) => setRequireLogin(ctx, input)),

  /** Who can enter: everyone in the org, groups (incl. SSO groups), named people. */
  setRules: abacProcedure('policy.write')
    .input(
      z.object({
        stack,
        everyone: z.boolean(),
        groups: z.array(z.string().min(1).max(120)).max(100),
        people: z.array(z.string().min(1)).max(500),
      }),
    )
    .mutation(({ ctx, input }) => setAppAccessRules(ctx, input)),

  /** The app's own users (auth: in swarmy.yaml) — its customers, not org members. */
  users: abacProcedure('service.configure', resolveStackByName)
    .input(z.object({ stack }))
    .query(({ ctx, input }) => listEndUsers(ctx, input.stack)),

  setUserDisabled: abacProcedure('service.configure', resolveStackByName)
    .input(z.object({ stack, userId: z.string().min(1), disabled: z.boolean() }))
    .mutation(({ ctx, input }) => setEndUserDisabled(ctx, input)),
});
