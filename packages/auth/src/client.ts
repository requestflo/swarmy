import { createAuthClient } from 'better-auth/react';
import { organizationClient } from 'better-auth/client/plugins';

/**
 * Browser auth client for the dashboard. `baseURL` is left to the same origin
 * (the app proxies `/api` → the controller), so requests hit `/api/auth/*`.
 */
export const authClient = createAuthClient({
  basePath: '/api/auth',
  plugins: [organizationClient()],
});

export const { signIn, signUp, signOut, useSession, organization } = authClient;
