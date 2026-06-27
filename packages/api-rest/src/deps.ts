/**
 * Dependency contract for the REST sub-app. The host (apps/api) injects the one
 * function that turns a presented API key into an OrgContext + the key's scopes —
 * the *same* OrgContext the tRPC `orgProcedure` builds, so handlers call the
 * existing services verbatim (zero logic duplication).
 */
import type { OrgContext } from '@swarmy/trpc';

export type ApiKeyScope = 'read' | 'write';

export interface ResolvedApiKey {
  ctx: OrgContext;
  apiKey: { id: string; scopes: ApiKeyScope[] };
}

export interface RestDeps {
  /**
   * Resolve an OrgContext from a presented API key (raw header value, with or
   * without a `Bearer ` prefix). Returns `null` for unknown/revoked keys.
   * Wired in apps/api from `resolveOrgContextFromApiKey(@swarmy/trpc)`.
   */
  resolveContextFromApiKey: (presentedKey: string) => Promise<ResolvedApiKey | null>;
}
