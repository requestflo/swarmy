/**
 * OAuth2 client-credentials grant for the public API (epic #13 public-api-terraform, Phase 2).
 *
 * Machine-to-machine auth: an `OAuthClient` is a long-lived `(clientId, clientSecret)`
 * credential pair. The `client_credentials` grant exchanges those for a SHORT-LIVED
 * bearer token. Crucially the issued token IS an ephemeral swarmy API key
 * (`swk_…`, with an `expiresAt`) so the existing `resolveOrgContextFromApiKey`
 * resolver works UNCHANGED — OAuth adds an issuance front door, it does not touch
 * the request-time auth seam.
 *
 * Secret posture mirrors `apiKeys.service`/join-tokens: the plaintext client
 * secret is shown EXACTLY ONCE at creation; only a sha-256 hash is persisted
 * (`@swarmy/core/crypto`), so it is never recoverable.
 *
 * The `OAuthClient` model is delivered as an INTEGRATION snippet (it cannot live
 * in the committed schema until migrated); like `terminal.service.ts` we reach
 * the not-yet-generated delegate through a single narrowly-typed `models()` cast.
 */
import { hashToken, randomToken, verifyTokenHash } from '@swarmy/core/crypto';
import { randomBytes } from 'node:crypto';
import type { DB } from '@swarmy/db';
import type { Auth } from '@swarmy/auth';
import type { OrgContext } from '../context';
import { notFound } from '../errors';
import type { AgentHub } from '../hub/types';
import { writeAudit } from './audit.service';
import { API_KEY_PREFIX } from './apiKeys.service';

/** Wire prefix for swarmy OAuth client ids — greppable in logs / leak scanners. */
export const OAUTH_CLIENT_PREFIX = 'swc';
/** Wire prefix for the issued (long, never-stored) client secret. */
export const OAUTH_SECRET_PREFIX = 'swcs';

/** Default lifetime of an issued access token: one hour. */
export const OAUTH_TOKEN_TTL_SECONDS = 3600;

export type OAuthScope = 'read' | 'write';

export interface OAuthClientView {
  id: string;
  name: string;
  clientId: string;
  scopes: OAuthScope[];
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  status: 'active' | 'revoked';
}

/** Returned ONCE at creation — carries the plaintext client secret. */
export interface OAuthClientIssued extends OAuthClientView {
  /** Plaintext `swcs_…` — not stored, never returned again. */
  clientSecret: string;
}

export interface OAuthTokenIssued {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
}

interface OAuthClientRow {
  id: string;
  orgId: string;
  name: string;
  clientId: string;
  clientSecretHash: string;
  scopes: unknown;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/**
 * The single `oAuthClient` delegate, narrowed to the methods we use. A single
 * cast confines the "model not yet generated" gap to one place (mirrors
 * `terminal.service.ts`). After the schema migration lands this is a no-op cast.
 */
interface OAuthDelegates {
  oAuthClient: {
    create(args: { data: Record<string, unknown> }): Promise<OAuthClientRow>;
    update(args: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<OAuthClientRow>;
    findFirst(args: {
      where: Record<string, unknown>;
      select?: Record<string, boolean>;
    }): Promise<OAuthClientRow | null>;
    findUnique(args: {
      where: { clientId: string };
    }): Promise<OAuthClientRow | null>;
    findMany(args: {
      where: Record<string, unknown>;
      orderBy?: Record<string, 'asc' | 'desc'>;
    }): Promise<OAuthClientRow[]>;
  };
}

function models(db: DB): OAuthDelegates {
  return db as unknown as OAuthDelegates;
}

function toView(row: OAuthClientRow): OAuthClientView {
  return {
    id: row.id,
    name: row.name,
    clientId: row.clientId,
    scopes: ((row.scopes as OAuthScope[] | null) ?? ['read']) as OAuthScope[],
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    status: row.revokedAt ? 'revoked' : 'active',
  };
}

export async function listOAuthClients(ctx: OrgContext): Promise<OAuthClientView[]> {
  const rows = await models(ctx.db).oAuthClient.findMany({
    where: { orgId: ctx.activeOrgId },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toView);
}

export async function createOAuthClient(
  ctx: OrgContext,
  input: { name: string; scopes?: OAuthScope[] },
): Promise<OAuthClientIssued> {
  const scopes = input.scopes && input.scopes.length ? input.scopes : (['read'] as OAuthScope[]);
  const clientId = `${OAUTH_CLIENT_PREFIX}_${randomBytes(12).toString('hex')}`;
  const clientSecret = randomToken(OAUTH_SECRET_PREFIX); // swcs_<base64url>

  const row = await models(ctx.db).oAuthClient.create({
    data: {
      orgId: ctx.activeOrgId,
      name: input.name,
      clientId,
      clientSecretHash: hashToken(clientSecret),
      scopes,
    },
  });
  await writeAudit(ctx, {
    action: 'oauthClient.create',
    targetType: 'oauthClient',
    targetId: row.id,
    metadata: { name: input.name, scopes, clientId },
  });
  return { ...toView(row), clientSecret };
}

export async function revokeOAuthClient(
  ctx: OrgContext,
  id: string,
): Promise<{ id: string; revoked: true }> {
  const row = await models(ctx.db).oAuthClient.findFirst({
    where: { id, orgId: ctx.activeOrgId },
    select: { id: true },
  });
  if (!row) throw notFound('oauth client', id);
  await models(ctx.db).oAuthClient.update({ where: { id }, data: { revokedAt: new Date() } });
  await writeAudit(ctx, {
    action: 'oauthClient.revoke',
    targetType: 'oauthClient',
    targetId: id,
  });
  return { id, revoked: true };
}

export interface IssueTokenDeps {
  db: DB;
  hub: AgentHub;
  auth: Auth;
}

/**
 * Validate a `(clientId, clientSecret)` pair (pure, exported for unit tests):
 * the client must exist, be unactive-revoked, and the presented secret must
 * match the stored hash in constant time. Returns the resolved row or `null`.
 */
export async function verifyClientCredentials(
  db: DB,
  clientId: string,
  clientSecret: string,
): Promise<OAuthClientRow | null> {
  if (!clientId || !clientSecret) return null;
  const row = await models(db).oAuthClient.findUnique({ where: { clientId } });
  if (!row || row.revokedAt) return null;
  if (!verifyTokenHash(clientSecret, row.clientSecretHash)) return null;
  return row;
}

/**
 * The `client_credentials` grant: validate the client, then mint a short-lived
 * `swk_…` API key (reusing the exact ApiKey persistence the resolver reads) with
 * an `expiresAt`. The plaintext key becomes the bearer `access_token`. The key's
 * `createdById` is left null (machine identity); the resolver tolerates this by
 * resolving any org member — see note below — so we stamp the org's owner as the
 * principal to keep ABAC well-defined.
 *
 * Returns `null` when the credentials are invalid (caller maps to 401).
 */
export async function issueToken(
  deps: IssueTokenDeps,
  input: { clientId: string; clientSecret: string },
): Promise<OAuthTokenIssued | null> {
  const client = await verifyClientCredentials(deps.db, input.clientId, input.clientSecret);
  if (!client) return null;

  const scopes = ((client.scopes as OAuthScope[] | null) ?? ['read']) as OAuthScope[];

  // The minted key must be resolvable by `resolveOrgContextFromApiKey`, whose
  // principal is the key's creator. Bind the token to the org's owner so the
  // resolved OrgContext has a well-defined, current membership/role.
  const owner = await deps.db.member.findFirst({
    where: { organizationId: client.orgId, role: 'owner' },
    select: { userId: true },
  });
  const createdById =
    owner?.userId ??
    (
      await deps.db.member.findFirst({
        where: { organizationId: client.orgId },
        select: { userId: true },
      })
    )?.userId ??
    null;

  // Same `swk_<prefix>_<secret>` shape as apiKeys.service.createApiKey.
  const prefix = randomBytes(4).toString('hex');
  const secret = randomToken(API_KEY_PREFIX);
  const key = `${API_KEY_PREFIX}_${prefix}_${secret.slice(API_KEY_PREFIX.length + 1)}`;
  const expiresAt = new Date(Date.now() + OAUTH_TOKEN_TTL_SECONDS * 1000);

  await deps.db.apiKey.create({
    data: {
      orgId: client.orgId,
      name: `oauth:${client.name}`,
      keyHash: hashToken(key),
      prefix,
      scopes,
      createdById,
      expiresAt,
    } as never,
  });

  // Best-effort last-used stamp; never blocks the grant.
  void models(deps.db)
    .oAuthClient.update({ where: { id: client.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);

  return {
    access_token: key,
    token_type: 'Bearer',
    expires_in: OAUTH_TOKEN_TTL_SECONDS,
    scope: scopes.join(' '),
  };
}
