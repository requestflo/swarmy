import { createAuthClient } from 'better-auth/react';
import {
  organizationClient,
  magicLinkClient,
  genericOAuthClient,
  twoFactorClient,
  usernameClient,
} from 'better-auth/client/plugins';
import { oauthProviderClient } from '@better-auth/oauth-provider/client';

/**
 * Browser auth client for the dashboard. `baseURL` is left to the same origin
 * (the app proxies `/api` → the controller), so requests hit `/api/auth/*`.
 *
 * Plugins:
 *  - organizationClient: active-org switching + membership (existing).
 *  - magicLinkClient: `authClient.signIn.magicLink({ email })`.
 *  - twoFactorClient: authenticator-app 2FA — `twoFactor.enable/verifyTotp/
 *    verifyBackupCode/generateBackupCodes/disable`. A password sign-in by an
 *    enrolled user answers `{ twoFactorRedirect: true }` instead of a session;
 *    the login page then shows the code step (no full-page redirect).
 *  - genericOAuthClient: `authClient.signIn.oauth2({ providerId })` for org SSO
 *    (any OIDC IdP: Keycloak, Authentik, Zitadel, Entra ID…). Social providers
 *    (Microsoft, Google, GitHub, GitLab) use `authClient.signIn.social`.
 *  - oauthProviderClient: swarmy is an OIDC provider (NetBird signs in with
 *    swarmy accounts). While `/login` carries a signed authorize query, sign-in
 *    answers `{ redirect: true, url }` to resume the authorize flow.
 *  - usernameClient: `authClient.signIn.username({ username, password })` —
 *    email is optional on swarmy; sign-up takes `username` and may omit email.
 *
 * Passkey enrolment uses the host-injected passkey plugin's client when present;
 * see INTEGRATION for adding `passkeyClient()` once the dep is available.
 */
export const authClient = createAuthClient({
  basePath: '/api/auth',
  plugins: [organizationClient(), magicLinkClient(), genericOAuthClient(), twoFactorClient(), usernameClient(), oauthProviderClient()],
});

export const { signIn, signUp, signOut, useSession, organization } = authClient;
