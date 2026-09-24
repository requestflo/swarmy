/** What Better Auth sign-in endpoints may answer besides a session. */
export interface AuthData {
  /** Password OK, the account has 2FA: show the code step. */
  twoFactorRedirect?: boolean;
  /** An OIDC authorize flow (swarmy as IdP, e.g. NetBird) resumes at `url`. */
  redirect?: boolean;
  url?: string;
}

/** Follow an OAuth-provider resume (`{ redirect, url }`); true when navigating away. */
export function followRedirect(data: unknown): boolean {
  const d = data as AuthData | null;
  if (d?.redirect && d.url) {
    window.location.href = d.url;
    return true;
  }
  return false;
}

