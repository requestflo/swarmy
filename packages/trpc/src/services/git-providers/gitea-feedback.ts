/**
 * Gitea / Forgejo feedback: a commit status per swarmy context
 * (`POST /repos/{owner}/{repo}/statuses/{sha}`) and ONE sticky PR comment
 * edited in place (PRs are issues to Gitea, so it is the issue-comments API).
 */
import { giteaApi, giteaAuth, giteaRepoPath } from './gitea';
import { requestJson, stickyMarker, type CommitStatusInput, type FetchLike } from './types';

/** Gitea has no `running`; it reads as pending until the final state lands. */
const GT_STATE: Record<CommitStatusInput['state'], string> = {
  pending: 'pending',
  running: 'pending',
  success: 'success',
  failure: 'failure',
  error: 'error',
};

export async function setGiteaCommitStatus(
  fetchFn: FetchLike,
  baseUrl: string,
  token: string,
  fullName: string,
  input: CommitStatusInput,
): Promise<void> {
  await requestJson(fetchFn, `${giteaApi(baseUrl)}/repos/${giteaRepoPath(fullName)}/statuses/${input.sha}`, {
    method: 'POST',
    headers: giteaAuth(token),
    body: JSON.stringify({
      state: GT_STATE[input.state],
      context: input.context,
      description: input.description.slice(0, 255),
      ...(input.targetUrl ? { target_url: input.targetUrl } : {}),
    }),
  });
}

/** Edit swarmy's one PR comment (by marker) or create it — PRs are issues to Gitea. */
export async function upsertGiteaStickyComment(
  fetchFn: FetchLike,
  baseUrl: string,
  token: string,
  fullName: string,
  prNumber: number,
  key: string,
  body: string,
): Promise<number> {
  const marker = stickyMarker(key);
  const full = `${marker}\n${body}`;
  const root = `${giteaApi(baseUrl)}/repos/${giteaRepoPath(fullName)}/issues`;
  const comments = await requestJson<{ id: number; body?: string }[]>(
    fetchFn,
    `${root}/${prNumber}/comments`,
    { headers: giteaAuth(token) },
  );
  const mine = comments.find((c) => c.body?.includes(marker));
  if (mine) {
    await requestJson(fetchFn, `${root}/comments/${mine.id}`, {
      method: 'PATCH',
      headers: giteaAuth(token),
      body: JSON.stringify({ body: full }),
    });
    return mine.id;
  }
  const created = await requestJson<{ id: number }>(fetchFn, `${root}/${prNumber}/comments`, {
    method: 'POST',
    headers: giteaAuth(token),
    body: JSON.stringify({ body: full }),
  });
  return created.id;
}
