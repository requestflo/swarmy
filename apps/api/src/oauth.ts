/**
 * OAuth2 token endpoint (epic #13 public-api-terraform, Phase 2).
 *
 * `POST /oauth/token` — the public, unauthenticated front door for the
 * `client_credentials` grant. Accepts either `application/x-www-form-urlencoded`
 * (the RFC 6749 default) or JSON:
 *
 *   grant_type=client_credentials & client_id=… & client_secret=…
 *
 * On success returns an RFC-6749-shaped token response carrying a SHORT-LIVED
 * `swk_…` API key as the bearer `access_token` (see `oauth.service.issueToken`):
 *
 *   { access_token, token_type: "Bearer", expires_in, scope }
 *
 * The route is mounted in apps/api/src/index.ts (snippet returned in INTEGRATION).
 */
import { Hono, type Context } from 'hono';
import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { issueToken } from '@swarmy/trpc';
import { hub } from './gateway';

export const oauthApp = new Hono();

/** RFC 6749 §5.2 error body. */
function oauthError(error: string, description?: string) {
  return description ? { error, error_description: description } : { error };
}

async function readCredentials(
  c: Context,
): Promise<{ grantType?: string; clientId?: string; clientSecret?: string }> {
  const contentType = c.req.header('content-type') ?? '';

  if (contentType.includes('application/json')) {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      grantType: typeof body.grant_type === 'string' ? body.grant_type : undefined,
      clientId: typeof body.client_id === 'string' ? body.client_id : undefined,
      clientSecret: typeof body.client_secret === 'string' ? body.client_secret : undefined,
    };
  }

  // form-urlencoded (default) or multipart.
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  return {
    grantType: str(form.grant_type),
    clientId: str(form.client_id),
    clientSecret: str(form.client_secret),
  };
}

oauthApp.post('/token', async (c) => {
  const { grantType, clientId, clientSecret } = await readCredentials(c);

  if (grantType !== 'client_credentials') {
    return c.json(
      oauthError('unsupported_grant_type', 'only client_credentials is supported'),
      400,
    );
  }
  if (!clientId || !clientSecret) {
    return c.json(oauthError('invalid_request', 'client_id and client_secret are required'), 400);
  }

  const token = await issueToken(
    { db: prisma, hub, auth: authRegistry.getAuth() },
    { clientId, clientSecret },
  );
  if (!token) {
    return c.json(oauthError('invalid_client', 'unknown or revoked client credentials'), 401);
  }

  // Token responses must not be cached (RFC 6749 §5.1).
  c.header('cache-control', 'no-store');
  c.header('pragma', 'no-cache');
  return c.json(token, 200);
});
