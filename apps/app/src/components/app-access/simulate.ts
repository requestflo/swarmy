import type { AppAccessPerson, AppAccessRoute } from './types';

/**
 * "Request to … · Simulate" (AppAccess board): what swarmy's edge does with
 * one request, decided the way `verifyAppRequest` decides it
 * (packages/trpc/src/services/app-access.service.ts):
 *
 *   route not behind Require login        → straight to the app
 *   no session (a stranger)                → 302 to swarmy's sign-in page
 *   signed in, `app.access` denies them    → 403, the app never sees it
 *   signed in, `app.access` permits them   → 200 + identity headers → the app
 *
 * `person.canEnter` is the real `app.access` decision from `appAccess.get`
 * (whoCan over the app's rules), so nothing here re-implements policy.
 */
export type SimOutcome = 'public' | 'passes' | 'signin' | 'denied';

export interface Simulation {
  outcome: SimOutcome;
  /** Did the sign-in check run at all (only on login-protected routes)? */
  checked: boolean;
  /** Did the request reach the app? */
  reaches: boolean;
  caption: string;
}

export const SIGN_IN_PATH = '/app-login';
export const JWKS_PATH = '/.well-known/swarmy-jwks.json';

export function personName(p: AppAccessPerson): string {
  return p.name ?? p.email ?? 'This member';
}

export function simulateRequest(route: AppAccessRoute, person: AppAccessPerson | null, stack: string): Simulation {
  const where = route.path === '/' ? route.host : `${route.host}${route.path}`;
  if (!route.requireLogin) {
    return { outcome: 'public', checked: false, reaches: true, caption: `${where} is public, so every request goes straight to ${stack}.` };
  }
  if (!person) {
    return { outcome: 'signin', checked: true, reaches: false, caption: 'No session, so they are sent to sign in first. The app never sees the request.' };
  }
  const who = personName(person);
  return person.canEnter
    ? { outcome: 'passes', checked: true, reaches: true, caption: `${who} is signed in and allowed, so the request passes with their identity attached.` }
    : { outcome: 'denied', checked: true, reaches: false, caption: `${who} is signed in but not allowed in, so swarmy answers 403. The app never sees it.` };
}
