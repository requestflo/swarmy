import { createAuthClient } from 'better-auth/react';
import {
  organizationClient,
  magicLinkClient,
  genericOAuthClient,
} from 'better-auth/client/plugins';

/**
 * Browser auth client for the dashboard. `baseURL` is left to the same origin
 * (the app proxies `/api` → the controller), so requests hit `/api/auth/*`.
 *
 * Plugins:
 *  - organizationClient: active-org switching + membership (existing).
 *  - magicLinkClient: `authClient.signIn.magicLink({ email })`.
 *  - genericOAuthClient: `authClient.signIn.oauth2({ providerId })` for enterprise
 *    SSO (OIDC) — the dashboard resolves `providerId` from the email domain.
 *
 * Passkey enrolment uses the host-injected passkey plugin's client when present;
 * see INTEGRATION for adding `passkeyClient()` once the dep is available.
 */
export const authClient = createAuthClient({
  basePath: '/api/auth',
  plugins: [organizationClient(), magicLinkClient(), genericOAuthClient()],
});

export const { signIn, signUp, signOut, useSession, organization } = authClient;
