/**
 * What every provider's connection code shares: the client-facing view
 * (secrets never included), the kind ↔ DB enum mapping, and the HMAC key
 * that signs OAuth `state`. Split out of git-connections.service so a
 * per-provider service (git-gitea.service) can use it without an import cycle.
 */
import { createHmac } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { isVaultConfigured } from '@swarmy/core/crypto';

/** HMAC key for OAuth `state`, derived from the vault key (never the key itself). */
export function stateKey(): string {
  const k = process.env.SWARMY_SECRET_KEY;
  if (!k || !isVaultConfigured()) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message:
        'SWARMY_SECRET_KEY is not set — swarmy cannot store git credentials without its vault.',
    });
  }
  return createHmac('sha256', k).update('swarmy:git-oauth-state:v1').digest('hex');
}

export type GitConnectionKind = 'github' | 'gitlab' | 'gitea' | 'generic';

export interface GitConnectionView {
  id: string;
  kind: GitConnectionKind;
  displayName: string;
  baseUrl: string;
  account: string | null;
  status: string;
  repoCount: number;
  createdAt: string;
}

export const KIND_TO_DB = {
  github: 'GITHUB',
  gitlab: 'GITLAB',
  gitea: 'GITEA',
  generic: 'GENERIC',
} as const;

export const kindFromDb = (k: string): GitConnectionKind => k.toLowerCase() as GitConnectionKind;

export function toConnectionView(r: {
  id: string;
  kind: string;
  displayName: string;
  baseUrl: string;
  account: string | null;
  status: string;
  createdAt: Date;
  _count?: { repos: number };
}): GitConnectionView {
  return {
    id: r.id,
    kind: kindFromDb(r.kind),
    displayName: r.displayName,
    baseUrl: r.baseUrl,
    account: r.account,
    status: r.status,
    repoCount: r._count?.repos ?? 0,
    createdAt: r.createdAt.toISOString(),
  };
}
