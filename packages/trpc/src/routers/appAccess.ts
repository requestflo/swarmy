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
import { recentAppSignIns, SIGN_INS_MAX } from '../services/app-access-sign-ins';
import { setAppPathRules } from '../services/app-access-paths.service';
import { setAppSignIn } from '../services/app-access-signin.service';

const stack = z.string().min(1).max(120);
const names = z.array(z.string().min(1).max(200)).max(200).optional();
const pathRule = z
  .object({
    path: z.string().min(1).max(512),
    everyone: z.boolean().optional(),
    roles: z.array(z.enum(['owner', 'admin', 'member'])).max(3).optional(),
    groups: names,
    people: names,
  })
  .strict();

/**
 * The app Access panel (dev-platform §2): "Require login" (identity-aware
 * proxy), who can enter (ABAC `app.access` rules on the stack) and — for apps
 * with `auth:` in swarmy.yaml — the app's own end users.
 */
export const appAccessRouter = router({
  get: abacProcedure('stack.read', resolveStackByName)
    .input(z.object({ stack }))
    .query(({ ctx, input }) => getAppAccess(ctx, input.stack)),

  /** Recent sign-ins: who signed in (and how), who was refused — newest first, from the audit log. */
  signIns: abacProcedure('stack.read', resolveStackByName)
    .input(z.object({ stack, limit: z.number().int().min(1).max(SIGN_INS_MAX).optional() }))
    .query(({ ctx, input }) => recentAppSignIns(ctx, input)),

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

  /**
   * Per-path who-can-enter on one protected address ("/admin/* → group
   * admins"). Narrows who gets in, so it is an access-rule write.
   */
  setPathRules: abacProcedure('policy.write', resolveStackByName)
    .input(z.object({ stack, routeId: z.string().min(1).max(600), rules: z.array(pathRule).max(50) }))
    .mutation(({ ctx, input }) => setAppPathRules(ctx, input)),

  /**
   * Which swarmy sign-ins the app accepts: any, or only the org's own SSO.
   * Who may enter changes, so it is an access-rule write.
   */
  setSignIn: abacProcedure('policy.write', resolveStackByName)
    .input(z.object({ stack, mode: z.enum(['any', 'sso']) }))
    .mutation(({ ctx, input }) => setAppSignIn(ctx, input)),

  /** The app's own users (auth: in swarmy.yaml) — its customers, not org members. */
  users: abacProcedure('service.configure', resolveStackByName)
    .input(z.object({ stack }))
    .query(({ ctx, input }) => listEndUsers(ctx, input.stack)),

  setUserDisabled: abacProcedure('service.configure', resolveStackByName)
    .input(z.object({ stack, userId: z.string().min(1), disabled: z.boolean() }))
    .mutation(({ ctx, input }) => setEndUserDisabled(ctx, input)),
});
