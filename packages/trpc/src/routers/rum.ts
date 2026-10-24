import { z } from 'zod';
import { FunnelsSchema, RUM_ROUTE_MODES, RumSettingsSchema } from '@swarmy/rum';
import { adminProcedure, orgProcedure, router } from '../trpc';
import { abacProcedure } from '../abac';
import { resolveConfigRow } from '../abac-config';
import { applyNow } from '../services/ingress.service';
import { getRumSettings, setRumRoute, setRumSettings } from '../services/rum/rum-settings.service';
import { getRumFunnels, setRumFunnels } from '../services/rum/rum-funnels.service';
import { funnel } from '../services/rum/rum-funnel';
import { analytics, deleteSession, deleteUser, footprint, getReplay, listReplays } from '../services/rum/rum-query';

const stack = z.string().min(1).max(200);
const sessionId = z.string().regex(/^[0-9a-z]{10,40}$/);

/**
 * Web analytics + session replay (dev-platform epic §5 + §7). Settings are
 * Docker labels on the app's services; saving re-renders ingress (the edge
 * injects the tag) — the app is never redeployed or modified.
 */
export const rumRouter = router({
  getSettings: orgProcedure.input(z.object({ stack })).query(({ ctx, input }) => getRumSettings(ctx, input.stack)),

  setSettings: adminProcedure
    .input(z.object({ stack, settings: RumSettingsSchema }))
    .mutation(({ ctx, input }) => setRumSettings(ctx, input, applyNow)),

  setRoute: adminProcedure
    .input(
      z.object({
        stack,
        service: z.string().min(1),
        host: z.string().min(1),
        path: z.string().default('/'),
        override: z.enum(RUM_ROUTE_MODES).nullable(),
      }),
    )
    .mutation(({ ctx, input }) => setRumRoute(ctx, input, applyNow)),

  analytics: orgProcedure
    .input(z.object({ stack, days: z.number().int().min(1).max(90).optional() }))
    .query(({ ctx, input }) => analytics(ctx, input)),

  /** The app's conversion funnels (the `swarmy.rum.funnels` label). */
  getFunnels: orgProcedure.input(z.object({ stack })).query(({ ctx, input }) => getRumFunnels(ctx, input.stack)),

  /** Replace the app's funnels — gated like setSettings (owner/admin), audited. Nothing re-renders. */
  setFunnels: adminProcedure
    .input(z.object({ stack, funnels: FunnelsSchema }))
    .mutation(({ ctx, input }) => setRumFunnels(ctx, input)),

  /** One funnel: visitors per step, conversion, the biggest drop and the release since which it worsened. */
  funnel: orgProcedure
    .input(
      z.object({
        stack,
        funnel: z.string().min(1).max(40),
        days: z.number().int().min(1).max(90).optional(),
        /** Signed-in people only — honoured in identified mode, ignored in privacy mode. */
        signedIn: z.boolean().optional(),
      }),
    )
    .query(({ ctx, input }) => funnel(ctx, input)),

  footprint: orgProcedure.input(z.object({ stack })).query(({ ctx, input }) => footprint(ctx, input.stack)),

  replays: orgProcedure
    .input(
      z.object({
        stack,
        days: z.number().int().min(1).max(365).optional(),
        withErrors: z.boolean().optional(),
        userId: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
    )
    .query(({ ctx, input }) => listReplays(ctx, input)),

  /** One replay with its synced timeline (requests, logs, server errors). Audited: replays are personal data. */
  replay: orgProcedure.input(z.object({ stack, sessionId })).query(({ ctx, input }) => getReplay(ctx, input)),

  /** GDPR: erase one session (replay chunks, replay index, its analytics rows). `rum.remove`, owner/admin by default. */
  deleteSession: abacProcedure('rum.remove', resolveConfigRow('rumSession', 'sessionId'))
    .input(z.object({ stack, sessionId }))
    .mutation(({ ctx, input }) => deleteSession(ctx, input)),

  /** GDPR: erase everything tied to a user id (one app, or every app when `stack` is omitted). `rum.remove`. */
  deleteUser: abacProcedure('rum.remove', resolveConfigRow('rumUser', 'userId'))
    .input(z.object({ stack: stack.optional(), userId: z.string().min(1).max(200) }))
    .mutation(({ ctx, input }) => deleteUser(ctx, input)),
});
