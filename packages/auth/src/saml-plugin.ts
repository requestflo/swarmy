import { sso } from '@better-auth/sso';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import type { ResolvedSsoProvider } from './config';
import { groupsFromClaim, mapGroups } from './identity';
import { stashSsoGroups } from './provisioning';
import { requireAnsweredRequest } from './saml-request';
import {
  SAML_ACS_PREFIX,
  SAML_METADATA_PATH,
  SAML_SECURITY,
  SAML_SIGN_IN_PATH,
  samlReady,
  ssoPublicBase,
  toSamlProvider,
} from './saml';

/**
 * Org SAML providers, served by `@better-auth/sso` from the `SsoProvider`
 * rows (handed over as `defaultSSO`, rebuilt with the instance on every
 * change), never from the plugin's own provider table.
 *
 * The plugin's org assignment is off: org binding, JIT membership and group
 * sync are swarmy's (provisioning.ts), exactly as for OIDC. Its domain-based
 * assignment would otherwise join social sign-ins to an org by email domain,
 * around the social providers' `allowedDomains`.
 */

/** A path under `/api/auth` the guard lets through for a configured provider. */
export function samlRequestAllowed(path: string, url: URL, ids: ReadonlySet<string>): boolean {
  if (path === SAML_METADATA_PATH) return ids.has(url.searchParams.get('providerId') ?? '');
  if (path.startsWith(SAML_ACS_PREFIX)) {
    try {
      return ids.has(decodeURIComponent(path.slice(SAML_ACS_PREFIX.length)));
    } catch {
      return false;
    }
  }
  return false;
}

function authPath(url: URL, baseURL: string): string {
  const base = new URL(baseURL).pathname.replace(/\/+$/, '');
  const p = url.pathname.replace(/\/+$/, '');
  return base && p.startsWith(base) ? p.slice(base.length) || '/' : p;
}

/**
 * Only SP metadata, the ACS and SP-initiated sign-in, only for providers swarmy
 * configured. The plugin's provider CRUD (`/sso/register`, …), its OIDC
 * callbacks and single logout all answer 404, so nothing reaches its own table
 * and no user can register an IdP. The ACS takes only answers to our own
 * AuthnRequests (saml-request.ts).
 */
function samlGuard(ids: ReadonlySet<string>): BetterAuthPlugin {
  return {
    id: 'swarmy-saml-guard',
    onRequest: async (request, ctx) => {
      const url = new URL(request.url);
      const path = authPath(url, ctx.baseURL);
      if (!path.startsWith('/sso/') || samlRequestAllowed(path, url, ids)) return;
      return { response: new Response('Not Found', { status: 404 }) };
    },
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === SAML_SIGN_IN_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            const body = (ctx.body ?? {}) as Record<string, unknown>;
            const id = body.providerId;
            if (typeof id !== 'string' || !ids.has(id)) {
              throw new APIError('NOT_FOUND', { message: 'No SAML provider found' });
            }
            return { context: { body: { ...body, providerType: 'saml' } } };
          }),
        },
        requireAnsweredRequest,
      ],
    },
  } satisfies BetterAuthPlugin;
}

/** The plugin options for these providers (exported for the mapping test). */
export function samlPluginOptions(ready: ResolvedSsoProvider[], base: string = ssoPublicBase()) {
  const byId = new Map(ready.map((p) => [p.providerId, p]));
  return {
    defaultSSO: ready.map((p) => toSamlProvider(p, base)),
    // Not a swarmy table: a lookup that ever fell past `defaultSSO` fails closed.
    modelName: 'samlPluginProviderUnused',
    organizationProvisioning: { disabled: true },
    providersLimit: 0,
    trustEmailVerified: false,
    disableImplicitSignUp: false,
    provisionUserOnEveryLogin: true,
    // Runs after the user and session exist, before the ACS answers: park the
    // IdP's groups for the provisioning after-hook (the OIDC mapper does the same).
    provisionUser: async ({ user, userInfo, provider }: { user: { email: string }; userInfo: Record<string, unknown>; provider: { providerId: string } }) => {
      const p = byId.get(provider.providerId);
      if (!p) return;
      stashSsoGroups(p.providerId, user.email, mapGroups(groupsFromClaim(userInfo, 'groups'), p.groupMap));
    },
    saml: { ...SAML_SECURITY },
  };
}

/** The SAML plugins for the configured providers; none when no row is ready. */
export function swarmySaml(providers: ResolvedSsoProvider[], base: string = ssoPublicBase()): BetterAuthPlugin[] {
  const ready = providers.filter(samlReady);
  if (!ready.length) return [];
  return [sso(samlPluginOptions(ready, base)) as unknown as BetterAuthPlugin, samlGuard(new Set(ready.map((p) => p.providerId)))];
}
