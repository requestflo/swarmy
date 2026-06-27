import { betterAuth, type BetterAuthPlugin } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { organization, magicLink } from 'better-auth/plugins';
import { genericOAuth } from 'better-auth/plugins/generic-oauth';
import { prisma, type DB } from '@swarmy/db';
import {
  loadAuthConfig,
  type ResolvedAuthConfig,
  type ResolvedSsoProvider,
} from './config';

/**
 * A magic-link sender. Wired to the platform email sender (shared with org
 * invitations). Until an email path is configured, the default logs the link so
 * local dev still works; production must supply a real sender.
 */
export type SendMagicLink = (data: { email: string; url: string; token: string }) => Promise<void>;

const defaultSendMagicLink: SendMagicLink = async ({ email, url }) => {
  // eslint-disable-next-line no-console
  console.info(`[auth] magic link for ${email}: ${url}`);
};

/**
 * Optional extra Better Auth plugins injected by the host. Used to wire plugins
 * whose package may not be present at build time (e.g. the passkey plugin) — the
 * host dynamically imports `better-auth/plugins/passkey` and passes `passkey()`
 * here when `config.passkey` is on. Keeps `@swarmy/auth` dependency-light.
 */
export type ExtraPlugin = BetterAuthPlugin;

export interface BuildAuthOptions {
  db?: DB;
  sendMagicLink?: SendMagicLink;
  /** Extra plugins to merge (e.g. a host-provided passkey plugin). */
  extraPlugins?: ExtraPlugin[];
}

/** Map a resolved OIDC SSO provider to a genericOAuth provider config. */
function ssoToGenericOAuth(p: ResolvedSsoProvider) {
  const mapping = p.mapping ?? {};
  return {
    providerId: p.providerId,
    clientId: p.clientId ?? '',
    clientSecret: p.clientSecret ?? '',
    ...(p.discoveryUrl ? { discoveryUrl: p.discoveryUrl } : {}),
    ...(p.issuer ? { issuer: p.issuer } : {}),
    ...(p.authorizationUrl ? { authorizationUrl: p.authorizationUrl } : {}),
    ...(p.tokenUrl ? { tokenUrl: p.tokenUrl } : {}),
    ...(p.userInfoUrl ? { userInfoUrl: p.userInfoUrl } : {}),
    scopes: p.scopes ?? ['openid', 'email', 'profile'],
    ...(Object.keys(mapping).length
      ? {
          mapProfileToUser: (profile: Record<string, unknown>) => {
            const out: Record<string, unknown> = {};
            for (const [userField, claim] of Object.entries(mapping)) {
              if (profile[claim] !== undefined) out[userField] = profile[claim];
            }
            return out;
          },
        }
      : {}),
  };
}

/**
 * Build a Better Auth instance from a resolved (decrypted) config. The static
 * bits — Prisma adapter, secret, baseURL, trustedOrigins, session, organization
 * plugin, emailAndPassword — are always present; social providers, magic-link,
 * passkey (host-injected), and enterprise SSO (genericOAuth, OIDC) are added
 * conditionally from `config` so providers can be toggled at runtime without a
 * source edit or restart.
 *
 * @param config resolved providers (decrypted secrets); defaults to none.
 * @param opts host injections: the Prisma client, magic-link sender, extra plugins.
 */
export function buildAuth(
  config: ResolvedAuthConfig = { social: {} },
  opts: BuildAuthOptions = {},
) {
  const db = opts.db ?? prisma;
  const socialProviders: Record<string, { clientId: string; clientSecret: string; scope?: string[] }> =
    {};
  for (const [id, provider] of Object.entries(config.social)) {
    if (!provider) continue;
    socialProviders[id] = {
      clientId: provider.clientId,
      clientSecret: provider.clientSecret,
      ...(provider.scopes ? { scope: provider.scopes } : {}),
    };
  }

  // Enterprise SSO (OIDC) goes through genericOAuth; SAML providers are stored
  // but skipped here (no SAML plugin in this Better Auth version — see INTEGRATION).
  const oidcSso = (config.sso ?? []).filter(
    (p) => p.protocol === 'oidc' && p.clientId && p.clientSecret && (p.discoveryUrl || p.issuer || p.authorizationUrl),
  );

  // Optional plugins, typed as BetterAuthPlugin so the array stays well-typed.
  // `organization()` is kept as the static element 0 so `Auth` always infers the
  // org API (e.g. `auth.api.setActiveOrganization`) and the org session fields.
  const optional: BetterAuthPlugin[] = [];
  if (config.magicLink) {
    optional.push(
      magicLink({
        sendMagicLink: async ({ email, url, token }) => {
          await (opts.sendMagicLink ?? defaultSendMagicLink)({ email, url, token });
        },
      }),
    );
  }
  if (oidcSso.length) {
    optional.push(genericOAuth({ config: oidcSso.map(ssoToGenericOAuth) }) as BetterAuthPlugin);
  }
  if (opts.extraPlugins?.length) {
    optional.push(...opts.extraPlugins);
  }

  return betterAuth({
    database: prismaAdapter(db, { provider: 'postgresql' }),
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3001',
    trustedOrigins: [
      process.env.CONTROLLER_PUBLIC_URL ?? 'http://localhost:3001',
      'http://localhost:3003',
    ],
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
    },
    ...(Object.keys(socialProviders).length ? { socialProviders } : {}),
    session: {
      cookieCache: { enabled: true, maxAge: 60 },
    },
    plugins: [organization(), ...optional],
  });
}

export type Auth = ReturnType<typeof buildAuth>;
export type Session = Auth['$Infer']['Session'];
export type AuthUser = Auth['$Infer']['Session']['user'];

/**
 * Holds the current Better Auth instance behind `getAuth()`. On a provider config
 * change a tRPC mutation calls `rebuild()` which constructs a fresh instance from
 * the DB and atomically swaps the reference — no process restart. In-flight
 * requests keep the instance they captured; sessions live in cookies/DB and are
 * unaffected by the swap.
 */
export class AuthRegistry {
  private current: Auth;

  constructor(
    private readonly db: DB = prisma,
    initial?: ResolvedAuthConfig,
    private readonly opts: BuildAuthOptions = {},
  ) {
    this.current = buildAuth(initial, { db, ...opts });
  }

  getAuth(): Auth {
    return this.current;
  }

  /** Reload provider config from the DB and swap in a freshly-built instance. */
  async rebuild(): Promise<Auth> {
    const config = await loadAuthConfig(this.db);
    this.current = buildAuth(config, { db: this.db, ...this.opts });
    return this.current;
  }
}

/** The process-wide registry. Call `authRegistry.rebuild()` at boot and on change. */
export const authRegistry = new AuthRegistry();

/**
 * Back-compat eager singleton (static config, no social providers). Existing
 * imports of `auth` keep working; new code should prefer `authRegistry.getAuth()`
 * so runtime provider toggles take effect.
 */
export const auth = authRegistry.getAuth();
