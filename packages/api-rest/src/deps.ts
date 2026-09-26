/**
 * Dependency contract for the REST sub-app. The host (apps/api) injects the one
 * function that turns a presented API key into an OrgContext + the key's scopes —
 * the *same* OrgContext the tRPC `orgProcedure` builds, so handlers call the
 * existing services verbatim (zero logic duplication).
 */
import type { OrgContext } from '@swarmy/trpc';

export type { ApiKeyScope } from '@swarmy/core';
import type { ApiKeyScope } from '@swarmy/core';

export interface ResolvedApiKey {
  ctx: OrgContext;
  /** `kind` says which credential it was; OAuth tokens carry `oauth:<client_id>` as id. */
  apiKey: { id: string; scopes: ApiKeyScope[]; kind?: 'api_key' | 'oauth'; stackNames?: string[] | null };
}

export interface RestDeps {
  /**
   * Resolve an OrgContext from a presented bearer (raw header value, with or
   * without a `Bearer ` prefix): an `swk_…` API key, or an OAuth access token
   * swarmy issued for its own APIs. Returns `null` for unknown/revoked ones.
   * Wired in apps/api from `resolveOrgContextFromBearer(@swarmy/trpc/devx)`.
   */
  resolveContextFromApiKey: (presentedKey: string) => Promise<ResolvedApiKey | null>;
}
