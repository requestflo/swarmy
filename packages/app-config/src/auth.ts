/**
 * `auth:` in swarmy.yaml — end-user sign-in as a resource (dev-platform §2B).
 *
 *   auth:
 *     providers: [google, github, microsoft, oidc]
 *     email: magic-link            # or password, or none
 *     allowedDomains: [acme.com]   # optional: only these email domains may sign up
 *     oidc: { issuer: https://login.acme.com, name: Acme SSO }
 *
 * swarmy deploys one small Better Auth service per app (`swarmy-auth`, the
 * `swarmy-app-auth` image — docker/app-auth) and routes `/auth/*` on every
 * host the app serves to it, so sessions are first-party on the app's own
 * domain. Its database is its own SQLite file on a volume, or — when the app
 * already has a managed Postgres — that database (`database:` picks one).
 * Provider credentials are Docker secrets the service reads from
 * /run/secrets: `auth-<provider>-client-id` and `auth-<provider>-client-secret`.
 * Every other service gets `SWARMY_AUTH_URL` (the in-swarm address) so
 * `@swarmy/app-auth`'s `getSession(req)` works with no configuration.
 */
import { z } from 'zod';
import { issue, type ConfigIssue } from './issues';
import type { AppConfig } from './schema';

export const AUTH_PROVIDERS = ['google', 'github', 'microsoft', 'oidc'] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];
export const AUTH_EMAIL_MODES = ['magic-link', 'password', 'none'] as const;
export type AuthEmailMode = (typeof AUTH_EMAIL_MODES)[number];

/** The synthetic unit swarmy adds for an app with `auth:`. */
export const AUTH_UNIT = 'swarmy-auth';
export const AUTH_PORT = 3000;
/** Route prefix on the app's domain (a trailing slash so `/authors` stays the app's). */
export const AUTH_ROUTE_PATH = '/auth/';
export const AUTH_BASE_PATH = '/auth';
/** Keep in step with `appAuth` in @swarmy/core system-images.ts (auth.test.ts pins it). */
export const APP_AUTH_IMAGE = 'ghcr.io/requestflo/swarmy-app-auth:latest';

const emailDomain = z
  .string()
  .regex(/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i, 'an email domain like acme.com');

export const AuthSchema = z
  .object({
    providers: z.array(z.enum(AUTH_PROVIDERS)).optional(),
    email: z.enum(AUTH_EMAIL_MODES).optional(),
    allowedDomains: z.array(emailDomain).optional(),
    allowed_domains: z.array(emailDomain).optional(),
    /** Generic OIDC (Okta, Keycloak, Entra, …): required with `providers: [oidc]`. */
    oidc: z
      .object({ issuer: z.string().url('an https issuer URL'), name: z.string().min(1).max(40).optional() })
      .strict()
      .optional(),
    /** Microsoft Entra tenant (default `common`). */
    microsoft: z.object({ tenant: z.string().min(1) }).strict().optional(),
    /** Postgres resource to keep users in (default: the only postgres, else a SQLite volume). */
    database: z.string().optional(),
  })
  .strict();
export type AuthInput = z.input<typeof AuthSchema>;
export type AuthConfig = z.output<typeof AuthSchema>;

/** The Docker secrets one provider's credentials are read from. */
export function authProviderSecrets(p: AuthProvider): [string, string] {
  return [`auth-${p}-client-id`, `auth-${p}-client-secret`];
}

/** In-swarm address of an app's auth service (the SDK's `SWARMY_AUTH_URL`). */
export function authServiceUrl(stack: string): string {
  return `http://${stack}_${AUTH_UNIT}:${AUTH_PORT}`;
}

function postgresResources(cfg: AppConfig): string[] {
  return Object.entries(cfg.resources ?? {})
    .filter(([, r]) => (typeof r === 'string' ? r : r.type) === 'postgres')
    .map(([n]) => n)
    .sort();
}

/** The postgres resource the auth service uses, or null for its own SQLite volume. */
export function authDatabase(cfg: AppConfig): string | null {
  if (!cfg.auth) return null;
  if (cfg.auth.database) return cfg.auth.database;
  const pgs = postgresResources(cfg);
  return pgs.length === 1 ? pgs[0]! : null;
}

export function authEmailMode(a: AuthConfig): AuthEmailMode {
  return a.email ?? ((a.providers ?? []).length ? 'none' : 'magic-link');
}

/** Cross-field rules for `auth:` (run by parseAppConfig after the structural schema). */
export function validateAuth(cfg: AppConfig): ConfigIssue[] {
  const a = cfg.auth;
  if (!a) return [];
  const out: ConfigIssue[] = [];
  const providers = a.providers ?? [];
  if (cfg.services[AUTH_UNIT]) {
    out.push(issue('error', 'auth/name-taken', ['services', AUTH_UNIT], `"${AUTH_UNIT}" is reserved for the app's auth service`));
  }
  if (providers.length === 0 && authEmailMode(a) === 'none') {
    out.push(issue('error', 'auth/no-method', ['auth'], 'auth needs at least one provider or an email sign-in mode'));
  }
  if (providers.includes('oidc') && !a.oidc?.issuer) {
    out.push(issue('error', 'auth/oidc-issuer', ['auth', 'oidc'], 'the oidc provider needs `oidc: { issuer: https://… }`'));
  }
  if (a.database !== undefined && !postgresResources(cfg).includes(a.database)) {
    out.push(issue('error', 'auth/database', ['auth', 'database'], `"${a.database}" is not a postgres resource of this app`));
  }
  const routed = Object.values(cfg.services).some((s) => s.port !== undefined && (s.domains ?? []).length > 0);
  if (!routed) {
    out.push(issue('warning', 'auth/no-domain', ['auth'], 'auth is served at /auth on the app\'s domains — add a domain to a service'));
  }
  if (a.allowedDomains && a.allowed_domains) {
    out.push(issue('warning', 'auth/allowed-domains', ['auth'], 'set allowedDomains or allowed_domains, not both'));
  }
  return out;
}

/**
 * The auth service as an ordinary service input — `toDesired` runs it through
 * the same normalisation as any other (bindings, secrets, volumes, signature).
 * `hosts` = every host the app routes; each gets `/auth/*` → this service.
 */
export function authServiceInput(cfg: AppConfig, stack: string, hosts: readonly string[]): AppConfig['services'][string] {
  const a = cfg.auth!;
  const providers = [...new Set(a.providers ?? [])].sort();
  const db = authDatabase(cfg);
  const allowed = a.allowedDomains ?? a.allowed_domains ?? [];
  const env: Record<string, string> = {
    AUTH_BASE_PATH,
    AUTH_APP_URL: '${{ app.url }}',
    AUTH_HOSTS: [...hosts].sort().join(','),
    AUTH_PROVIDERS: providers.join(','),
    AUTH_EMAIL: authEmailMode(a),
    SWARMY_STACK: stack,
    ...(allowed.length ? { AUTH_ALLOWED_DOMAINS: allowed.join(',') } : {}),
    ...(a.oidc ? { AUTH_OIDC_ISSUER: a.oidc.issuer, ...(a.oidc.name ? { AUTH_OIDC_NAME: a.oidc.name } : {}) } : {}),
    ...(a.microsoft ? { AUTH_MICROSOFT_TENANT: a.microsoft.tenant } : {}),
    ...(db ? { DATABASE_URL: `\${{ ${db}.url }}` } : { AUTH_SQLITE_PATH: '/data/auth.sqlite' }),
  };
  return {
    image: APP_AUTH_IMAGE,
    port: AUTH_PORT,
    replicas: 1,
    memory: '192mb',
    env,
    secrets: providers.flatMap(authProviderSecrets),
    ...(db ? {} : { volumes: { data: '/data' } }),
    healthcheck: { path: `${AUTH_BASE_PATH}/ok`, interval: '15s', timeout: '5s', start_period: '20s' },
  } as AppConfig['services'][string];
}
