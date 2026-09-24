/**
 * Git feedback (git-apps Phase 2): tell the provider what swarmy did with a
 * commit — a GitHub check run (falling back to a classic commit status) or a
 * GitLab commit status — and keep ONE sticky PR/MR comment (plan + preview
 * URL) edited in place.
 *
 * Best-effort by design: feedback never delays or fails a build or deploy.
 * Every function swallows provider errors (returning false) — a provider
 * outage must not become a swarmy outage.
 */
import type { DB } from '@swarmy/db';
import {
  githubApiBase,
  githubFullName,
  setGithubCommitStatus,
  setGitlabCommitStatus,
  upsertCheckRun,
  upsertGithubStickyComment,
  upsertGitlabStickyNote,
  type CommitStatusInput,
} from './git-providers';
import { connectionCredentials, gitFetch, loadConnectionRow } from './git-credentials';

export interface FeedbackRepo {
  id: string;
  url: string;
  provider: string;
  connectionId: string | null;
  fullName: string | null;
  externalRepoId: string | null;
}

export const SHA_RE = /^[0-9a-f]{40}$/;

/** check-run ids per (repo, sha, context) so a later update PATCHes the same run. */
const checkRuns = new Map<string, number>();
const MAX_TRACKED_RUNS = 2000;

async function providerAccess(db: DB, repo: FeedbackRepo) {
  if (!repo.connectionId) return null;
  const conn = await loadConnectionRow(db, repo.connectionId);
  if (!conn || conn.status !== 'active') return null;
  const creds = await connectionCredentials(db, conn);
  if (!creds.token) return null;
  return { conn, token: creds.token };
}

/** Report a commit state (`swarmy / build`, `swarmy / plan`, `swarmy / deploy`). */
export async function reportCommitStatus(
  db: DB,
  repo: FeedbackRepo,
  input: CommitStatusInput & { summary?: string },
): Promise<boolean> {
  if (!SHA_RE.test(input.sha)) return false;
  try {
    const access = await providerAccess(db, repo);
    if (!access) return false;
    const { conn, token } = access;
    if (conn.kind === 'GITHUB') {
      const fullName = repo.fullName ?? githubFullName(repo.url, conn.baseUrl);
      if (!fullName) return false;
      const apiBase = githubApiBase(conn.baseUrl);
      const key = `${repo.id}:${input.sha}:${input.context}`;
      try {
        const id = await upsertCheckRun(gitFetch, apiBase, token, fullName, {
          ...input,
          checkRunId: checkRuns.get(key),
        });
        if (checkRuns.size > MAX_TRACKED_RUNS) checkRuns.clear();
        checkRuns.set(key, id);
      } catch {
        // Installation without checks:write (older App) — a classic status still works.
        await setGithubCommitStatus(gitFetch, apiBase, token, fullName, input);
      }
      return true;
    }
    if (conn.kind === 'GITLAB') {
      const projectId = repo.externalRepoId ?? repo.fullName;
      if (!projectId) return false;
      await setGitlabCommitStatus(gitFetch, conn.baseUrl, token, projectId, input);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Edit-or-create swarmy's single comment on a PR/MR, keyed (e.g. `plan:orders`). */
export async function upsertPrComment(
  db: DB,
  repo: FeedbackRepo,
  input: { pr: number; key: string; body: string },
): Promise<boolean> {
  try {
    const access = await providerAccess(db, repo);
    if (!access) return false;
    const { conn, token } = access;
    if (conn.kind === 'GITHUB') {
      const fullName = repo.fullName ?? githubFullName(repo.url, conn.baseUrl);
      if (!fullName) return false;
      await upsertGithubStickyComment(
        gitFetch,
        githubApiBase(conn.baseUrl),
        token,
        fullName,
        input.pr,
        input.key,
        input.body,
      );
      return true;
    }
    if (conn.kind === 'GITLAB') {
      const projectId = repo.externalRepoId ?? repo.fullName;
      if (!projectId) return false;
      await upsertGitlabStickyNote(
        gitFetch,
        conn.baseUrl,
        token,
        projectId,
        input.pr,
        input.key,
        input.body,
      );
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** The body of the preview comment swarmy keeps on a PR (pure). */
export function previewCommentBody(input: {
  stack: string;
  url: string | null;
  sha: string | null;
  state: 'deployed' | 'failed' | 'torn-down';
  reason?: string;
}): string {
  const short = input.sha ? input.sha.slice(0, 7) : null;
  if (input.state === 'torn-down')
    return `### swarmy preview\n\nPreview \`${input.stack}\` was torn down.`;
  if (input.state === 'failed') {
    return `### swarmy preview\n\nPreview \`${input.stack}\`${short ? ` for \`${short}\`` : ''} failed${input.reason ? `: ${input.reason}` : '.'}`;
  }
  return [
    '### swarmy preview',
    '',
    input.url
      ? `Live at **${input.url}**`
      : `Deployed as \`${input.stack}\` (no preview domain configured).`,
    '',
    `Stack \`${input.stack}\`${short ? ` · commit \`${short}\`` : ''}. Updates on every push; torn down when the PR closes.`,
  ].join('\n');
}
