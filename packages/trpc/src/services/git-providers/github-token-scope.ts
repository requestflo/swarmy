/**
 * Least-privilege GitHub installation tokens (security review M7). An App
 * installation may cover every repo of an account; a token minted for one
 * job is narrowed to the ONE repository it touches (`repositories: [name]`)
 * and to the permissions that job needs — so a token leaked from a build
 * container can read one repo's code, not write statuses across the account.
 *
 * Pure: `git-credentials.ts` mints (and caches per scope) with this body.
 */

/** What the token is for. */
export type GithubTokenAccess =
  /** The repo picker (`GET /installation/repositories`): no repo yet, metadata only. */
  | 'list'
  /** Clone / inspect / build / branch heads of one repo. */
  | 'read'
  /** Check runs, commit statuses and the sticky PR comment on one repo. */
  | 'feedback';

export const INSTALLATION_TOKEN_PERMISSIONS: Record<GithubTokenAccess, Record<string, 'read' | 'write'>> = {
  list: { metadata: 'read' },
  read: { contents: 'read', metadata: 'read' },
  feedback: { checks: 'write', statuses: 'write', pull_requests: 'write', metadata: 'read' },
};

export interface InstallationTokenRequest {
  repositories?: string[];
  permissions: Record<string, 'read' | 'write'>;
}

/**
 * The `POST /app/installations/{id}/access_tokens` body for a scope.
 * `repo` is `owner/name` (or a bare name); repo-scoped access without one
 * throws — a token is never widened to the whole installation by accident.
 */
export function installationTokenRequest(scope: {
  access: GithubTokenAccess;
  repo?: string | null;
}): InstallationTokenRequest {
  const permissions = { ...INSTALLATION_TOKEN_PERMISSIONS[scope.access] };
  if (scope.access === 'list') return { permissions };
  const name = scope.repo?.replace(/\.git$/, '').split('/').filter(Boolean).pop();
  if (!name || !/^[A-Za-z0-9._-]{1,100}$/.test(name)) {
    throw new Error('a repository-scoped GitHub token needs the repository name');
  }
  return { repositories: [name], permissions };
}

/** Cache key for a minted token: one per installation × repo × access. */
export function installationTokenKey(connectionId: string, req: InstallationTokenRequest): string {
  return `${connectionId}|${req.repositories?.join(',') ?? '*'}|${Object.entries(req.permissions)
    .map(([k, v]) => `${k}:${v}`)
    .sort()
    .join(',')}`;
}
