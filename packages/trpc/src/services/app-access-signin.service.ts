/**
 * Which swarmy sign-ins a protected app accepts (board 65's provider
 * toggle): any swarmy sign-in, or only the org's own single sign-on. Stored
 * as `access.signIn` on each protected route's `swarmy.ingress.routes` entry
 * (Docker truth, no secrets) and checked after the org's account walls
 * (`appSignInWall`, app-access-walls.ts) on every uncached decision.
 */
import { TRPCError } from '@trpc/server';
import type { AppSignInMode } from '@swarmy/core';
import type { OrgContext } from '../context';
import { notFound } from '../errors';
import { writeAudit } from './audit.service';
import { listRoutesForOrg, type Route, type RouteAccess } from './ingress-routes';
import { setServiceRoutes } from './ingress-routes-api';
import { getAppAccess, type AppAccessView } from './app-access-admin.service';
import { readySsoProviders } from './sso-only-gate';

/** PURE: a protected route's access with the sign-in mode set (`any` leaves no key). */
export function withSignIn(access: RouteAccess, mode: AppSignInMode): RouteAccess {
  const { signIn: _drop, ...rest } = access;
  return mode === 'sso' ? { ...rest, signIn: 'sso' } : rest;
}

/** Set the sign-in method on every protected address of the app. */
export async function setAppSignIn(ctx: OrgContext, input: { stack: string; mode: AppSignInMode }): Promise<AppAccessView> {
  const all = listRoutesForOrg(ctx);
  const mine = all.filter((r) => r.stack === input.stack);
  if (mine.length === 0) throw notFound('app routes', input.stack);
  if (!mine.some((r) => r.route.access?.login === true)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Ask people to sign in on one of this app’s addresses first.' });
  }
  if (input.mode === 'sso' && (await readySsoProviders(ctx.db, ctx.activeOrgId)).length === 0) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Set up single sign-on for your organisation first, or nobody could get in.' });
  }
  const services = new Set(mine.filter((r) => r.route.access?.login === true).map((r) => r.serviceId));
  for (const serviceId of services) {
    const routes: Route[] = all
      .filter((r) => r.serviceId === serviceId)
      .map(({ route }) => (route.access?.login === true ? { ...route, access: withSignIn(route.access, input.mode) } : route));
    await setServiceRoutes(ctx, serviceId, routes);
  }
  await writeAudit(ctx, { action: 'app.access.signIn.set', targetType: 'stack', targetId: input.stack, metadata: { mode: input.mode } });
  return getAppAccess(ctx, input.stack);
}
