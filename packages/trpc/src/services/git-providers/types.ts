/**
 * Shared shapes for the git provider clients (GitHub App, GitLab, generic).
 *
 * Every client is a set of plain functions over an injected `fetch`, so they
 * are unit-tested with a recorded fake and never reach the network in tests.
 * Clients never persist anything and never log a token.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ProviderRepo {
  /** Provider's stable id (GitHub repo id / GitLab project id), as a string. */
  id: string;
  /** `owner/name` (GitHub) or `group/sub/name` (GitLab path_with_namespace). */
  fullName: string;
  cloneUrl: string;
  htmlUrl: string;
  defaultBranch: string;
  private: boolean;
}

export interface ProviderBranch {
  name: string;
  sha: string;
}

/** Commit-status vocabulary common to GitHub statuses and GitLab pipelines. */
export type CommitState = 'pending' | 'running' | 'success' | 'failure' | 'error';

export interface CommitStatusInput {
  sha: string;
  state: CommitState;
  /** Status name, e.g. `swarmy / plan` or `swarmy / build`. */
  context: string;
  description: string;
  targetUrl?: string;
}

export class GitProviderError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GitProviderError';
  }
}

/** JSON request helper: throws `GitProviderError` with the provider's message on non-2xx. */
export async function requestJson<T>(
  fetchFn: FetchLike,
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetchFn(url, {
    ...init,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as {
        message?: string;
        error_description?: string;
        error?: string;
      };
      msg = j.message ?? j.error_description ?? j.error ?? msg;
    } catch {
      // not JSON — keep the raw (truncated) text
    }
    throw new GitProviderError(
      res.status,
      `${init.method ?? 'GET'} ${redactUrl(url)} → ${res.status}: ${msg}`,
    );
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Strip query-string secrets (client_secret, access_token, …) from a URL before it lands in an error. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (/secret|token|code|password/i.test(k)) u.searchParams.set(k, '***');
    }
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return url;
  }
}

/** The hidden marker a sticky PR comment carries so swarmy edits it instead of re-posting. */
export function stickyMarker(key: string): string {
  return `<!-- swarmy:${key} -->`;
}
