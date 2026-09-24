import { z } from 'zod';

/**
 * "Protect my app" — the identity-aware proxy contract every ingress driver
 * renders (dev-platform epic §2A).
 *
 * A route carrying `auth` is gated at the edge: every request first asks the
 * swarmy controller (`verifyPath`, a forward-auth / auth_request subrequest)
 * whether the caller may enter. The controller checks the swarmy Better Auth
 * session behind a FIRST-PARTY cookie on the app's own domain, evaluates the
 * ABAC `app.access` action on the app's stack, and answers:
 *   - 2xx + identity headers ({@link APP_AUTH_IDENTITY_HEADERS}) → proxied on;
 *   - 302 to swarmy's login page (or 401 in `status` mode for nginx) → no session;
 *   - 403 → signed in, but not allowed.
 *
 * The login round trip ends on `<app host>{@link APP_AUTH_PATH_PREFIX}/callback`,
 * which every driver maps onto the controller's `/_app-auth/*` (Host kept) so
 * the controller can set the cookie on the app's domain — never a shared
 * parent-domain cookie.
 *
 * Header hygiene is part of the contract: a driver MUST drop every client-sent
 * `X-Swarmy-*` header before the auth step, so the upstream can trust the ones
 * it receives (they only ever come from the controller's answer).
 */

/** Path prefix on the APP's domain that carries the login callback + logout. */
export const APP_AUTH_PATH_PREFIX = '/.swarmy/auth';
/** Controller path the app-domain prefix is rewritten onto. */
export const APP_AUTH_CONTROLLER_PREFIX = '/_app-auth';
/** Identity headers the controller answers with, copied onto the upstream request. */
export const APP_AUTH_IDENTITY_HEADERS = [
  'X-Swarmy-User',
  'X-Swarmy-Email',
  'X-Swarmy-Groups',
  'X-Swarmy-Jwt',
] as const;
/**
 * Set by the edge on the auth subrequest only: the request URI BEFORE any
 * rewrite / prefix strip, so the post-login redirect lands where the user was.
 */
export const APP_AUTH_ORIGINAL_URI_HEADER = 'X-Swarmy-Original-Uri';
/** `status` = answer 401 instead of redirecting (nginx auth_request cannot pass a 302 through). */
export const APP_AUTH_MODE_HEADER = 'X-Swarmy-Auth-Mode';

export const RouteAuthSchema = z.object({
  /** Controller dial target `host:port`, reachable from the edge (the activator's upstream). */
  upstream: z.string().min(1),
  /** Forward-auth subrequest path on the controller, org-scoped: `/_app-auth/verify?org=<id>`. */
  verifyPath: z.string().startsWith('/'),
});
export type RouteAuth = z.infer<typeof RouteAuthSchema>;

/** The verify path for an org (the org scopes the host → route lookup). */
export function appAuthVerifyPath(orgId: string): string {
  return `${APP_AUTH_CONTROLLER_PREFIX}/verify?org=${encodeURIComponent(orgId)}`;
}
