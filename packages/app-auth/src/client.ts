/**
 * Browser helpers for an app using swarmy auth. Zero dependencies; every call
 * is a same-origin fetch to the app's own domain, so cookies stay first-party.
 *
 * End-user auth (`auth:` in swarmy.yaml) — the app's Better Auth service at
 * `/auth/*`:
 *   const auth = createAuthClient();
 *   await auth.signIn('github');                  // social / oidc redirect
 *   await auth.sendMagicLink('me@example.com');   // email: magic-link
 *   await auth.signInWithPassword(email, pw);     // email: password
 *   const s = await auth.session();               // { user } | null
 *   await auth.signOut();
 * Or skip UI entirely: link to `auth.hostedLoginUrl()` — the service's own
 * sign-in page with every enabled provider.
 *
 * Protect my app — the swarmy edge handles login; the app only offers sign-out:
 *   <a href={PROXY_LOGOUT_URL}>Sign out</a>
 */

/** Signs out of a "Protect my app" app (clears the app-domain swarmy cookie). */
export const PROXY_LOGOUT_URL = '/.swarmy/auth/logout';

export type SocialProvider = 'google' | 'github' | 'microsoft' | 'oidc';

export interface ProvidersInfo {
  providers: SocialProvider[];
  email: 'magic-link' | 'password' | 'none';
}

export interface ClientSession {
  user: { id: string; email: string | null; name: string | null; image?: string | null };
  session: { id: string; expiresAt: string };
}

export interface AuthClientOptions {
  /** Where the auth service is mounted on this origin (default `/auth`). */
  basePath?: string;
  fetch?: typeof fetch;
  /** Navigation hook (default `window.location.assign`). */
  navigate?: (url: string) => void;
}

export class AuthClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AuthClientError';
  }
}

export function createAuthClient(opts: AuthClientOptions = {}) {
  const base = (opts.basePath ?? '/auth').replace(/\/+$/, '');
  const f = opts.fetch ?? ((input, init) => fetch(input, init));
  const navigate = opts.navigate ?? ((url: string) => window.location.assign(url));
  const here = (): string => (typeof window === 'undefined' ? '/' : window.location.pathname + window.location.search);

  async function call<T>(path: string, body?: unknown): Promise<T> {
    const res = await f(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      headers: body === undefined ? { accept: 'application/json' } : { 'content-type': 'application/json', accept: 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : null;
    if (!res.ok) {
      const msg = (json as { message?: string } | null)?.message ?? `auth request failed (${res.status})`;
      throw new AuthClientError(msg, res.status);
    }
    return json as T;
  }

  return {
    /** Which providers + email mode this app's auth service has enabled. */
    providers: () => call<ProvidersInfo>('/swarmy/providers'),
    /** The current session, or null. */
    session: () => call<ClientSession | null>('/get-session'),
    /** Redirect to a social / OIDC provider; comes back to `callbackURL` (default: this page). */
    async signIn(provider: SocialProvider, o: { callbackURL?: string } = {}): Promise<void> {
      const callbackURL = o.callbackURL ?? here();
      const res =
        provider === 'oidc'
          ? await call<{ url?: string }>('/sign-in/oauth2', { providerId: 'oidc', callbackURL })
          : await call<{ url?: string }>('/sign-in/social', { provider, callbackURL });
      if (res.url) navigate(res.url);
    },
    /** Email a sign-in link (email: magic-link). */
    sendMagicLink: (email: string, o: { callbackURL?: string } = {}) =>
      call<{ status: boolean }>('/sign-in/magic-link', { email, callbackURL: o.callbackURL ?? here() }),
    /** Email + password sign-in (email: password). */
    signInWithPassword: (email: string, password: string) =>
      call<{ user: ClientSession['user'] }>('/sign-in/email', { email, password }),
    /** Email + password sign-up (email: password). */
    signUpWithPassword: (email: string, password: string, name = '') =>
      call<{ user: ClientSession['user'] }>('/sign-up/email', { email, password, name: name || email.split('@')[0] }),
    signOut: () => call<{ success: boolean }>('/sign-out', {}),
    /** The auth service's hosted sign-in page (no UI code needed in the app). */
    hostedLoginUrl: (callbackURL?: string) =>
      `${base}/login?callbackURL=${encodeURIComponent(callbackURL ?? here())}`,
  };
}
export type AuthClient = ReturnType<typeof createAuthClient>;
