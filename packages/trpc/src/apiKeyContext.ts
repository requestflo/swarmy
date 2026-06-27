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

export type ApiKeyScope = 'read' | 'write';

export interface ResolvedApiKeyContext {
  ctx: OrgContext;
  apiKey: { id: string; scopes: ApiKeyScope[] };
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
      createdById: true,
    },
  });
  if (!row || row.revokedAt) return null;

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

  // Build the same OrgContext shape orgProcedure produces. We do not have a
  // Better Auth session for a key, so session/user carry a synthetic principal
  // sufficient for the services layer (which reads ctx.user.id for audit/triggers).
  const ctx = {
    db: deps.db,
    hub: deps.hub,
    auth: deps.auth,
    session: { userId: creator.id, activeOrganizationId: row.orgId } as OrgContext['session'],
    user: { id: creator.id, email: creator.email, name: creator.name } as OrgContext['user'],
    activeOrgId: row.orgId,
    reqHeaders: new Headers(),
    membership: {
      role: member.role as 'owner' | 'admin' | 'member',
      orgId: member.organizationId,
    },
  } as OrgContext;

  return { ctx, apiKey: { id: row.id, scopes: (row.scopes as ApiKeyScope[]) ?? ['read'] } };
}
