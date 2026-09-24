import * as React from 'react';

/** Keys Better Auth's OAuth provider adds when it signs the authorize query onto `/login`. */
const SIGNATURE_KEYS = ['sig', 'exp', 'ba_iat', 'ba_param'];

/** True while `/login` is serving an OIDC authorize flow (swarmy as the IdP, e.g. NetBird). */
export function isOAuthAuthorizeFlow(): boolean {
  const q = new URLSearchParams(window.location.search);
  return q.has('sig') && q.has('client_id');
}

/** Go back to the authorize endpoint with the original (unsigned) query. */
export function resumeAuthorize(): void {
  const q = new URLSearchParams(window.location.search);
  for (const k of SIGNATURE_KEYS) q.delete(k);
  window.location.href = `/api/auth/oauth2/authorize?${q.toString()}`;
}

/**
 * Someone already signed in who lands on `/login` mid-authorize is sent back to
 * the authorize endpoint, which now sees the session and issues the code.
 */
export function useOAuthResume(signedIn: boolean): void {
  React.useEffect(() => {
    if (signedIn && isOAuthAuthorizeFlow()) resumeAuthorize();
  }, [signedIn]);
}
