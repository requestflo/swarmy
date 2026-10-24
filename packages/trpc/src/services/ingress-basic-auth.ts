/**
 * "Require a password" on a route — the controller half of
 * `packages/ingress/src/basic-auth.ts`.
 *
 * A new password arrives once, inside an `ingress.setServiceRoutes` write
 * (`abacProcedure('ingress.write')`, the same gate and update path as every
 * other protection). It is bcrypt-hashed here; the hash is sealed with the
 * vault key and kept in the org's ingress document (swarm-kv, where the tunnel
 * token is sealed too) under a random `rpw_<hex>` reference. Only the username
 * and that reference reach the `swarmy.ingress.routes` label.
 *
 * At render time {@link basicAuthResolver} turns references back into hashes
 * for the edge's own config. A reference that no longer resolves leaves the
 * route with no users, and the renderer refuses every request (fail closed).
 */
import { randomBytes } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { decryptSecret, encryptSecret } from '@swarmy/core/crypto';
import { BCRYPT_HASH_RE, type RouteBasicAuth, type RouteProtection, type RouteProtectionInput } from '@swarmy/ingress';
import type { OrgContext } from '../context';
import { ingressConfigRepo, ingressSettingsOf } from './ingress-config.repo';
import type { Route } from './ingress-routes';

/** Key of the sealed-hash map inside the org's ingress settings. */
export const ROUTE_PASSWORDS_KEY = 'routePasswords';

/** A route as a write may carry it: basic-auth users can bring a new `password`. */
export type RouteInput = Omit<Route, 'protection'> & { protection?: RouteProtection | RouteProtectionInput };

type Sealed = Record<string, string>;

function sealedOf(settings: Record<string, unknown>): Sealed {
  const v = settings[ROUTE_PASSWORDS_KEY];
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Sealed) : {};
}

function refsOf(routes: ReadonlyArray<{ protection?: { basicAuth?: { users: Array<{ passwordSecret?: string }> } } }>): Set<string> {
  const out = new Set<string>();
  for (const r of routes) for (const u of r.protection?.basicAuth?.users ?? []) if (u.passwordSecret) out.add(u.passwordSecret);
  return out;
}

/** bcrypt as Caddy reads it: Bun writes `$2b$`, stored as `$2a$` (same algorithm, like the maddy pass table). */
export async function hashRoutePassword(password: string): Promise<string> {
  const hash = await Bun.password.hash(password, { algorithm: 'bcrypt', cost: 12 });
  return hash.replace(/^\$2[by]\$/, '$2a$');
}

/**
 * Seal every new password and swap it for its reference; refuse a reference
 * the vault does not hold. `previous` is the service's live route set: the
 * references it used and the new set drops come back as `stale`, to forget
 * once the label write has landed ({@link forgetRoutePasswords}).
 */
export async function sealRoutePasswords(
  ctx: OrgContext,
  routes: RouteInput[],
  previous: Route[],
): Promise<{ routes: Route[]; stale: string[] }> {
  const fresh: Sealed = {};
  const out: Route[] = [];
  for (const r of routes) {
    const ba = r.protection?.basicAuth;
    if (!r.protection || !ba) {
      out.push(r as Route);
      continue;
    }
    const users: Array<{ username: string; passwordSecret: string }> = [];
    for (const u of ba.users as Array<{ username: string; passwordSecret?: string; password?: string }>) {
      if (u.password) {
        const ref = `rpw_${randomBytes(12).toString('hex')}`;
        fresh[ref] = encryptSecret(await hashRoutePassword(u.password));
        users.push({ username: u.username, passwordSecret: ref });
      } else if (u.passwordSecret) users.push({ username: u.username, passwordSecret: u.passwordSecret });
    }
    out.push({ ...r, protection: { ...r.protection, basicAuth: { users } } } as Route);
  }
  const keep = refsOf(out);
  const stale = [...refsOf(previous)].filter((ref) => !keep.has(ref));
  if (keep.size === 0) return { routes: out, stale };
  const sealed = sealedOf(ingressSettingsOf(await ingressConfigRepo.get(ctx, ctx.activeOrgId)));
  const missing = [...keep].filter((ref) => !(ref in sealed) && !(ref in fresh));
  if (missing.length > 0) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'a saved password is no longer stored — set it again' });
  }
  if (Object.keys(fresh).length > 0) await patchSealed(ctx, (cur) => ({ ...cur, ...fresh }));
  return { routes: out, stale };
}

/** Drop sealed hashes no route uses any more (after the label stopped naming them). */
export async function forgetRoutePasswords(ctx: OrgContext, refs: string[]): Promise<void> {
  if (refs.length === 0) return;
  await patchSealed(ctx, (cur) => Object.fromEntries(Object.entries(cur).filter(([ref]) => !refs.includes(ref))));
}

async function patchSealed(ctx: OrgContext, change: (cur: Sealed) => Sealed): Promise<void> {
  await ingressConfigRepo.update(ctx, ctx.activeOrgId, (cur) => {
    const settings = ingressSettingsOf(cur);
    return { settings: { ...settings, [ROUTE_PASSWORDS_KEY]: change(sealedOf(settings)) } };
  });
}

/**
 * Render-time resolver over the org's ingress settings: a route's label
 * `protection.basicAuth` → its users with their hashes. Users whose hash is
 * gone or unreadable are left out (none left ⇒ the route fails closed).
 */
export function basicAuthResolver(settings: Record<string, unknown>): (p: RouteProtection | undefined) => RouteBasicAuth | undefined {
  const sealed = sealedOf(settings);
  return (p) => {
    if (!p?.basicAuth) return undefined;
    const users: RouteBasicAuth['users'] = [];
    for (const u of p.basicAuth.users) {
      const blob = sealed[u.passwordSecret];
      let hash = '';
      try {
        hash = blob ? decryptSecret(blob) : '';
      } catch {
        hash = '';
      }
      if (BCRYPT_HASH_RE.test(hash)) users.push({ username: u.username, hash });
    }
    return { users };
  };
}
