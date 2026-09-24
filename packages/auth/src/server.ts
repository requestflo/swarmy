import { betterAuth, type BetterAuthPlugin } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { APIError } from 'better-auth/api';
import { organization, magicLink } from 'better-auth/plugins';
import { genericOAuth } from 'better-auth/plugins/generic-oauth';
import { prisma, type DB } from '@swarmy/db';
import {
  loadAuthConfig,
  type ResolvedAuthConfig,
  type ResolvedSsoProvider,
} from './config';
import { CLIENT_IP_HEADER } from './client-ip';
import {
  assertSignupAllowed,
  canCreateOrganization,
  ORG_CREATE_FORBIDDEN_MESSAGE,
} from './signup-policy';
import { authTrustedOrigins } from './origins';
import { mfaAssurance, swarmyTwoFactor } from './two-factor';
import { OIDC_DISABLED_PATHS, swarmyOidcProvider } from './oidc-provider';

/**
 * Per-IP limits for the credential endpoints. Keyed on the IP the host resolved
 * into {@link CLIENT_IP_HEADER} (see client-ip.ts) and the path, so one
 * attacker's burst never locks out anyone else. Pinned explicitly rather than
 * relying on Better Auth's built-in defaults so an upgrade can't silently loosen
 * them. Paths are relative to `/api/auth`.
 */
export const AUTH_RATE_LIMIT_RULES = {
  // Password / magic-link / social sign-in: 10 attempts per minute per IP.
  '/sign-in/**': { window: 60, max: 10 },
  // Account creation: 5 per 10 minutes per IP.
  '/sign-up/**': { window: 600, max: 5 },
  // Reset-mail requests (email bombing / enumeration): 3 per 15 minutes per IP.
  '/request-password-reset': { window: 900, max: 3 },
  '/forget-password/**': { window: 900, max: 3 },
  // Reset-token redemption (token brute force): 10 per 15 minutes per IP.
  '/reset-password/**': { window: 900, max: 10 },
  // Second-factor codes. The plugin also caps /two-factor/* at 3 per 10s;
  // this adds a per-minute ceiling so a slow grind is bounded too.
  '/two-factor/**': { window: 60, max: 10 },
  // Credential changes on a live session.
  '/change-password': { window: 60, max: 5 },
  '/change-email': { window: 60, max: 5 },
  '/send-verification-email': { window: 900, max: 3 },
} as const;

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
    baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3021',
    // Public URL + auth base + the direct http://<ip>:3021 (SWARMY_DIRECT_URL) —
    // an https dashboard domain must never lock out the pre-cert first login.
    trustedOrigins: authTrustedOrigins(),
    // Auto-select an active organization when a session is created and the user
    // belongs to one. The org plugin only sets `activeOrganizationId` when
    // explicitly called (the signup flow does), so a fresh sign-in would
    // otherwise land with no active org and `orgProcedure` would 403. This makes
    // single-org users (the seeded dev user, returning users) land on their org.
    databaseHooks: {
      // Invite-only registration (signup-policy.ts). This hook sits under EVERY
      // user-creating path — email/password sign-up, social + OIDC-SSO first
      // login, magic-link, passkey — so none of them can mint an account for a
      // stranger. Refusal surfaces as a 403 with the invite-only message.
      user: {
        create: {
          before: async (user) => {
            await assertSignupAllowed(db, user.email);
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            if (session.activeOrganizationId) return;
            const member = await db.member.findFirst({
              where: { userId: session.userId },
              orderBy: { createdAt: 'asc' },
              select: { organizationId: true },
            });
            if (!member) return;
            return { data: { ...session, activeOrganizationId: member.organizationId } };
          },
        },
      },
    },
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
    },
    // swarmy is also an OIDC provider (oidc-provider.ts); the jwt plugin's
    // session→JWT `/token` endpoint must not exist alongside it.
    disabledPaths: [...OIDC_DISABLED_PATHS],
    ...(Object.keys(socialProviders).length ? { socialProviders } : {}),
    session: {
      cookieCache: { enabled: true, maxAge: 60 },
    },
    advanced: {
      // Own cookie namespace. Browsers scope cookies by host, NOT port, so on
      // `localhost` (dev: :3021/:3023) every other Better Auth app shares the
      // default `better-auth.session_token` cookie — signing into any of them
      // overwrites ours and swarmy's next live session check (signature
      // mismatch) comes back empty → 401s + redirect to /login. Same risk for
      // any host that serves more than one Better Auth app. Override per
      // instance when running several swarmy controllers on one host.
      cookiePrefix: process.env.SWARMY_AUTH_COOKIE_PREFIX ?? 'swarmy',
      // The client IP comes ONLY from the header the controller's request entry
      // derives from the socket peer (apps/api → withClientIp). A raw
      // client-supplied X-Forwarded-For is never read here; it is honoured
      // upstream only when the socket peer is in SWARMY_TRUSTED_PROXIES.
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
    rateLimit: {
      // Better Auth's default (production-only); SWARMY_AUTH_RATE_LIMIT=0 opts out.
      ...(process.env.SWARMY_AUTH_RATE_LIMIT === '0' ? { enabled: false } : {}),
      customRules: { ...AUTH_RATE_LIMIT_RULES },
    },
    plugins: [
      organization({
        // Same policy for org creation: a signed-in user with no org cannot mint
        // one (and from it join tokens) unless registration is open, it is the
        // first-run bootstrap, or they already own an org (instance admin).
        allowUserToCreateOrganization: (user) => canCreateOrganization(db, user.id),
        organizationHooks: {
          beforeCreateOrganization: async ({ user }) => {
            // Belt-and-braces for Better Auth's server-side `userId` system path,
            // which skips `allowUserToCreateOrganization`. Only swarmy code calls
            // that path, but keep the policy total.
            if (user?.id && !(await canCreateOrganization(db, user.id))) {
              throw new APIError('FORBIDDEN', {
                message: ORG_CREATE_FORBIDDEN_MESSAGE,
                code: 'ORG_CREATE_FORBIDDEN',
              });
            }
          },
        },
      }),
      // Authenticator-app 2FA is always available (users opt in; orgs may
      // require it). Static so `Auth` infers `user.twoFactorEnabled` and the
      // `/two-factor/*` API. See two-factor.ts.
      swarmyTwoFactor(),
      mfaAssurance(db),
      // swarmy as an OIDC provider for in-cluster tools (NetBird). See oidc-provider.ts.
      ...swarmyOidcProvider(db),
      ...optional,
    ],
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
