/**
 * Env → config for the per-app auth service. Everything is plain env written
 * by swarmy (app-config `authServiceInput`) except provider credentials,
 * which are Docker secret FILES under /run/secrets.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PROVIDERS = ['google', 'github', 'microsoft', 'oidc'] as const;
export type Provider = (typeof PROVIDERS)[number];
export type EmailMode = 'magic-link' | 'password' | 'none';

export interface ProviderCreds {
  clientId: string;
  clientSecret: string;
}

export interface AuthServiceConfig {
  port: number;
  basePath: string;
  appUrl: string;
  hosts: string[];
  providers: Partial<Record<Provider, ProviderCreds>>;
  /** Providers listed in swarmy.yaml whose secrets are missing (logged, not fatal). */
  missing: Provider[];
  email: EmailMode;
  allowedDomains: string[];
  oidc?: { issuer: string; name: string };
  microsoftTenant?: string;
  database: { kind: 'postgres'; url: string } | { kind: 'sqlite'; path: string };
  stack: string;
  /** Controller JWKS candidates for admin calls from swarmy. */
  jwksUrls: string[];
  /** Optional delivery hook for magic-link emails (POST JSON {to, subject, text, url}). */
  emailWebhook?: string;
  secretsDir: string;
}

const list = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

function readSecret(dir: string, name: string): string | undefined {
  const p = join(dir, name);
  if (!existsSync(p)) return undefined;
  const v = readFileSync(p, 'utf8').trim();
  return v || undefined;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AuthServiceConfig {
  const secretsDir = env.AUTH_SECRETS_DIR ?? '/run/secrets';
  const wanted = list(env.AUTH_PROVIDERS).filter((p): p is Provider => (PROVIDERS as readonly string[]).includes(p));
  const providers: AuthServiceConfig['providers'] = {};
  const missing: Provider[] = [];
  for (const p of wanted) {
    const clientId = env[`AUTH_${p.toUpperCase()}_CLIENT_ID`] ?? readSecret(secretsDir, `auth-${p}-client-id`);
    const clientSecret = env[`AUTH_${p.toUpperCase()}_CLIENT_SECRET`] ?? readSecret(secretsDir, `auth-${p}-client-secret`);
    if (clientId && clientSecret) providers[p] = { clientId, clientSecret };
    else missing.push(p);
  }
  const email = (['magic-link', 'password', 'none'] as const).find((m) => m === env.AUTH_EMAIL) ?? 'magic-link';
  const appUrl = (env.AUTH_APP_URL ?? `http://localhost:${env.PORT ?? 3000}`).replace(/\/+$/, '');
  const hosts = list(env.AUTH_HOSTS);
  const stack = env.SWARMY_STACK ?? 'app';
  return {
    port: Number(env.PORT ?? 3000),
    basePath: env.AUTH_BASE_PATH ?? '/auth',
    appUrl,
    hosts,
    providers,
    missing,
    email,
    allowedDomains: list(env.AUTH_ALLOWED_DOMAINS).map((d) => d.toLowerCase()),
    ...(env.AUTH_OIDC_ISSUER ? { oidc: { issuer: env.AUTH_OIDC_ISSUER.replace(/\/+$/, ''), name: env.AUTH_OIDC_NAME ?? 'SSO' } } : {}),
    ...(env.AUTH_MICROSOFT_TENANT ? { microsoftTenant: env.AUTH_MICROSOFT_TENANT } : {}),
    database: env.DATABASE_URL
      ? { kind: 'postgres', url: env.DATABASE_URL }
      : { kind: 'sqlite', path: env.AUTH_SQLITE_PATH ?? '/data/auth.sqlite' },
    stack,
    jwksUrls: env.SWARMY_JWKS_URL
      ? list(env.SWARMY_JWKS_URL)
      : [
          'http://swarmy_controller:3021/.well-known/swarmy-jwks.json',
          'http://host.docker.internal:3021/.well-known/swarmy-jwks.json',
        ],
    ...(env.AUTH_EMAIL_WEBHOOK ? { emailWebhook: env.AUTH_EMAIL_WEBHOOK } : {}),
    secretsDir,
  };
}

/** May this email sign up? (allowedDomains empty = anyone.) */
export function emailAllowed(cfg: Pick<AuthServiceConfig, 'allowedDomains'>, email: string | null | undefined): boolean {
  if (cfg.allowedDomains.length === 0) return true;
  const domain = (email ?? '').toLowerCase().split('@')[1];
  return !!domain && cfg.allowedDomains.includes(domain);
}

/** The origins Better Auth trusts for callbacks: the app URL + every routed host. */
export function trustedOrigins(cfg: Pick<AuthServiceConfig, 'appUrl' | 'hosts'>): string[] {
  const out = new Set<string>([new URL(cfg.appUrl).origin]);
  for (const h of cfg.hosts) {
    out.add(`https://${h}`);
    out.add(`http://${h}`);
  }
  return [...out];
}
