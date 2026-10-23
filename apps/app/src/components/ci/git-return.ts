/**
 * The provider round trip always lands on `/ci?git=…` (apps/api/src/git-callback.ts).
 * When the trip started in the Deploy wizard, we note that in sessionStorage
 * before leaving, and the CI page's result banner sends the browser back to
 * the wizard with the same result. A note older than 30 minutes is ignored.
 */
const KEY = 'swarmy-git-return';
const MAX_AGE_MS = 30 * 60 * 1000;

export interface GitReturn {
  to: '/deploy';
  /** The GitHub host whose App this trip registers (the wizard shows the receipt). */
  created?: string;
}

/** Note where to come back to (or clear it with `null` when the trip starts on /ci). */
export function rememberGitReturn(r: GitReturn | null): void {
  try {
    if (r) sessionStorage.setItem(KEY, JSON.stringify({ ...r, at: Date.now() }));
    else sessionStorage.removeItem(KEY);
  } catch {
    // Storage blocked: the trip lands on /ci, which still works.
  }
}

/** Read and clear the note. */
export function takeGitReturn(): GitReturn | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { to?: unknown; created?: unknown; at?: unknown };
    if (v.to !== '/deploy' || typeof v.at !== 'number' || Date.now() - v.at > MAX_AGE_MS) return null;
    return { to: '/deploy', ...(typeof v.created === 'string' ? { created: v.created } : {}) };
  } catch {
    return null;
  }
}
