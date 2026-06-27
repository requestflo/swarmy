import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { organization } from 'better-auth/plugins';
import { prisma, type DB } from '@swarmy/db';
import { loadAuthConfig, type ResolvedAuthConfig } from './config';

/**
 * Build a Better Auth instance from a resolved (decrypted) config. The static
 * bits — Prisma adapter, secret, baseURL, trustedOrigins, session, organization
 * plugin, emailAndPassword — are always present; social providers are added
 * conditionally from `config` so providers can be toggled at runtime without a
 * source edit or restart.
 *
 * @param config resolved providers (decrypted secrets); defaults to none.
 * @param db Prisma client to bind the adapter to (defaults to the shared one).
 */
export function buildAuth(config: ResolvedAuthConfig = { social: {} }, db: DB = prisma) {
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
    plugins: [organization()],
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

  constructor(private readonly db: DB = prisma, initial?: ResolvedAuthConfig) {
    this.current = buildAuth(initial, db);
  }

  getAuth(): Auth {
    return this.current;
  }

  /** Reload provider config from the DB and swap in a freshly-built instance. */
  async rebuild(): Promise<Auth> {
    const config = await loadAuthConfig(this.db);
    this.current = buildAuth(config, this.db);
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
