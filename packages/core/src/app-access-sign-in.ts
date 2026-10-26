/**
 * Which swarmy sign-ins a login-protected app accepts (`access.signIn` on its
 * `swarmy.ingress.routes` entry, board 65): absent or `'any'` = any swarmy
 * sign-in (still behind the org's own 2FA / SSO-only walls); `'sso'` = only a
 * session that signed in with the app's org's own SSO provider. Any other
 * value is unreadable and the edge check lets nobody in.
 */
export type AppSignInMode = 'any' | 'sso';

/** A value a route may carry (absent included). */
export function isAppSignIn(v: unknown): v is AppSignInMode | undefined {
  return v === undefined || v === 'any' || v === 'sso';
}

/** The mode a route's value stands for; null = unreadable (fail closed). */
export function appSignInMode(v: unknown): AppSignInMode | null {
  if (v === undefined || v === 'any') return 'any';
  return v === 'sso' ? 'sso' : null;
}
