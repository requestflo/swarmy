/**
 * The single seam where an API key becomes a principal: turn a presented
 * `swk_…` key into the EXACT same {@link OrgContext} shape that `orgProcedure`
 * builds for a dashboard session — so every downstream service call is identical
 * whether it came from the browser or from `curl`/Terraform.
 *
 * Used by `@swarmy/api-rest` (`createRestApp({ resolveContextFromApiKey })`).
 */
import { hashToken } from '@swarmy/core/crypto';
import type { Auth } from '@swarmy/auth';
import type { DB } from '@swarmy/db';
import type { OrgContext } from './context';
import type { AgentHub } from './hub/types';

export type ApiKeyScope = 'read' | 'write' | 'secrets.read';

export interface ResolvedApiKeyContext {
  ctx: OrgContext;
  /** `kind` says which credential it was; OAuth tokens carry `oauth:<client_id>` as id. */
  apiKey: { id: string; scopes: ApiKeyScope[]; kind?: 'api_key' | 'oauth' };
}

export interface ResolveApiKeyDeps {
  db: DB;
  hub: AgentHub;
  auth: Auth;
}

/** Strip `Bearer ` / `Token ` prefixes; accept a bare key too. */
function normalizeKey(raw: string): string {
  const trimmed = raw.trim();
  const m = /^(?:Bearer|Token)\s+(.+)$/i.exec(trimmed);
  return (m?.[1] ?? trimmed).trim();
}

/**
 * Resolve an `OrgContext` from a presented API key, or `null` if the key is
 * unknown/revoked. The membership/role used for ABAC is the CURRENT role of the
 * key's creator (evaluated at request time, never a frozen snapshot — a key can
 * never outlive its creator's authority).
 */
export async function resolveOrgContextFromApiKey(
  deps: ResolveApiKeyDeps,
  presentedKey: string,
): Promise<ResolvedApiKeyContext | null> {
  const key = normalizeKey(presentedKey);
  if (!key) return null;

  const row = await deps.db.apiKey.findUnique({
    where: { keyHash: hashToken(key) },
    select: {
      id: true,
      orgId: true,
      scopes: true,
      revokedAt: true,
      expiresAt: true,
      createdById: true,
    },
  });
  if (!row || row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;

  // The principal "user" behind the key is its creator; resolve their current
  // membership in the key's org (the hard org-isolation boundary).
  const member = row.createdById
    ? await deps.db.member.findFirst({
        where: { organizationId: row.orgId, userId: row.createdById },
        select: { role: true, organizationId: true },
      })
    : null;

  const creator = row.createdById
    ? await deps.db.user.findUnique({
        where: { id: row.createdById },
        select: { id: true, email: true, name: true },
      })
    : null;

  if (!member || !creator) return null;

  // Best-effort last-used stamp; never blocks the request.
  void deps.db.apiKey
    .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);

  const ctx = principalContext(deps, row.orgId, creator, member);
  return { ctx, apiKey: { id: row.id, scopes: (row.scopes as ApiKeyScope[]) ?? ['read'], kind: 'api_key' } };
}

/**
 * Build the same OrgContext shape orgProcedure produces. We do not have a
 * Better Auth session for a key or token, so session/user carry a synthetic
 * principal sufficient for the services layer (which reads ctx.user.id for
 * audit/triggers).
 */
function principalContext(
  deps: ResolveApiKeyDeps,
  orgId: string,
  user: { id: string; email: string; name: string | null },
  member: { role: string; organizationId: string },
): OrgContext {
  return {
    db: deps.db,
    hub: deps.hub,
    auth: deps.auth,
    session: { userId: user.id, activeOrganizationId: orgId } as OrgContext['session'],
    user: { id: user.id, email: user.email, name: user.name } as OrgContext['user'],
    activeOrgId: orgId,
    reqHeaders: new Headers(),
    membership: {
      role: member.role as 'owner' | 'admin' | 'member',
      orgId: member.organizationId,
    },
  } as OrgContext;
}

/** A verified swarmy-issued OAuth access token (see `createApiTokenVerifier` in @swarmy/auth). */
export interface VerifiedBearerToken {
  userId: string;
  scopes: string[];
  orgId: string | null;
  clientId: string | null;
}

export interface ResolveBearerDeps extends ResolveApiKeyDeps {
  /** Verifies a JWT access token issued by swarmy's OIDC provider for swarmy's APIs; null = invalid. */
  verifyAccessToken?: (token: string) => Promise<VerifiedBearerToken | null>;
}

/** OAuth scope → API scope: `swarmy:write` implies read; anything else grants nothing here. */
export function apiScopesFromOAuth(scopes: readonly string[]): ApiKeyScope[] {
  if (scopes.includes('swarmy:write')) return ['read', 'write'];
  if (scopes.includes('swarmy:read')) return ['read'];
  return [];
}

/**
 * The bearer seam for every non-browser front door (REST `/api/v1`, MCP
 * `/mcp`): an `swk_…` API key, or an OAuth access token swarmy issued for
 * its own APIs. Either way the principal is the CURRENT membership of the
 * user behind it (never a frozen snapshot) and the same OrgContext shape.
 */
export async function resolveOrgContextFromBearer(
  deps: ResolveBearerDeps,
  presented: string,
): Promise<ResolvedApiKeyContext | null> {
  const token = normalizeKey(presented);
  if (!token) return null;
  if (token.startsWith('swk_')) return resolveOrgContextFromApiKey(deps, token);
  if (!deps.verifyAccessToken || token.split('.').length !== 3) return null;

  const claims = await deps.verifyAccessToken(token).catch(() => null);
  if (!claims) return null;
  const scopes = apiScopesFromOAuth(claims.scopes);
  if (!scopes.length) return null;

  // The org the token was issued in; else the user's earliest org (what the
  // provider puts in the claim, and what a fresh session activates).
  const member = await deps.db.member.findFirst({
    where: { userId: claims.userId, ...(claims.orgId ? { organizationId: claims.orgId } : {}) },
    orderBy: { createdAt: 'asc' },
    select: { role: true, organizationId: true },
  });
  if (!member) return null;
  const user = await deps.db.user.findUnique({
    where: { id: claims.userId },
    select: { id: true, email: true, name: true },
  });
  if (!user) return null;

  const ctx = principalContext(deps, member.organizationId, user, member);
  return { ctx, apiKey: { id: `oauth:${claims.clientId ?? 'client'}`, scopes, kind: 'oauth' } };
}

