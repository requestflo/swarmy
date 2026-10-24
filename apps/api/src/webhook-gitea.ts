/**
 * Gitea / Forgejo webhooks → the GitHub dialect the receiver already speaks.
 *
 * Gitea's push and pull-request payloads are GitHub-shaped, with two
 * differences that matter to swarmy: a PR update arrives as `synchronized`
 * (GitHub: `synchronize`), and a deleted branch is its own `delete` event
 * (`{ ref: "feature-x", ref_type: "branch" }`) rather than a push to zeros.
 * Every other event (create, issues, releases, …) is acknowledged and ignored.
 *
 * Pure, and it runs only AFTER `verifyGiteaSignature` has accepted the body.
 */

export type GiteaHook =
  | { ignore: string }
  | { event: 'push' | 'pull_request'; body: unknown };

const ZERO_SHA = '0'.repeat(40);

export function normalizeGiteaHook(event: string | null | undefined, body: unknown): GiteaHook {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  if (event === 'push') return { event, body };
  if (event === 'pull_request') {
    return { event, body: b.action === 'synchronized' ? { ...b, action: 'synchronize' } : body };
  }
  if (event === 'delete') {
    if (b.ref_type !== 'branch' || typeof b.ref !== 'string' || !b.ref) return { ignore: 'tag deleted' };
    const ref = b.ref.replace(/^refs\/heads\//, '');
    // The push shape `isBranchDelete` already recognises (deleted + all-zero sha).
    return { event: 'push', body: { ref: `refs/heads/${ref}`, after: ZERO_SHA, deleted: true } };
  }
  return { ignore: event || 'event' };
}
