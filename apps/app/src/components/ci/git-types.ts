/**
 * View shapes for the git-connect UI — mirrors of
 * packages/trpc/src/services/git-connections.service.ts (GitConnectionView,
 * LinkedRepoView) and git-providers/types.ts (ProviderRepo). Kept local so the
 * app never imports server modules; tRPC's inferred types flow into these.
 */
export type GitConnectionKind = 'github' | 'gitlab' | 'gitea' | 'generic';

export interface GitConnection {
  id: string;
  kind: GitConnectionKind;
  displayName: string;
  baseUrl: string;
  account: string | null;
  status: string;
  repoCount: number;
  createdAt: string;
}

export interface ProviderRepo {
  id: string;
  fullName: string;
  cloneUrl: string;
  htmlUrl: string;
  defaultBranch: string;
  private: boolean;
}

export interface LinkedRepo {
  id: string;
  url: string;
  branch: string;
  configPath: string;
  fullName: string | null;
  webhook: { url: string; secret: string } | null;
  deployKeyPublic: string | null;
}

export const KIND_LABEL: Record<GitConnectionKind, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  gitea: 'Gitea',
  generic: 'Git',
};

/** Providers with a repo listing API — the rest take a typed URL. */
export function canListRepos(kind: GitConnectionKind): boolean {
  return kind !== 'generic';
}

/** Branch listing exists for GitHub + GitLab only (see listProviderBranches). */
export function canListBranches(kind: GitConnectionKind): boolean {
  return kind === 'github' || kind === 'gitlab';
}

/** GitHub's branches API takes `owner/name`; GitLab's takes the project id. */
export function branchRepoKey(kind: GitConnectionKind, repo: ProviderRepo): string {
  return kind === 'gitlab' ? repo.id : repo.fullName;
}

/** Connection status → StatusBadge tone + plain words. */
export function connectionStatus(status: string): {
  tone: 'online' | 'progress' | 'warning';
  label: string;
} {
  if (status === 'active') return { tone: 'online', label: 'Connected' };
  if (status === 'pending') return { tone: 'progress', label: 'Waiting for sign-in' };
  return { tone: 'warning', label: status.replace(/[-_]/g, ' ') };
}

/** Input to `gitConnections.linkRepo` (a picked repo XOR a typed URL). */
export interface LinkRepoRequest {
  connectionId?: string;
  repo?: { id: string; fullName: string; cloneUrl: string };
  url?: string;
  branch: string;
  configPath?: string;
  deployKey?: boolean;
}
