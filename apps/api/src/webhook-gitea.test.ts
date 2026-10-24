import { describe, expect, it } from 'bun:test';
import { normalizeGiteaHook } from './webhook-gitea';
import {
  isForkPullRequest,
  parseCommitSha,
  parsePrWebhookEvent,
  parsePushRef,
  pushChangedPaths,
  verifyGiteaSignature,
} from './webhook-verify';

// Trimmed real payloads from Gitea 1.22 / Forgejo 9 (`X-Gitea-Event` in the comment).
const repo = { id: 42, full_name: 'northwind/shop' };
const PUSH = {
  ref: 'refs/heads/main',
  before: '1'.repeat(40),
  after: '2'.repeat(40),
  commits: [{ id: '2'.repeat(40), added: ['web/new.ts'], modified: ['swarmy.yaml'], removed: [] }],
  head_commit: { id: '2'.repeat(40) },
  repository: repo,
};
const PR = (action: string, headRepo = repo) => ({
  action,
  number: 12,
  pull_request: {
    number: 12,
    merged: action === 'closed',
    head: { ref: 'feat/cart', sha: '3'.repeat(40), repo: headRepo },
    base: { ref: 'main', sha: '1'.repeat(40), repo },
  },
  repository: repo,
});

describe('gitea webhooks (X-Gitea-Signature, GitHub dialect)', () => {
  it('verifies the bare-hex HMAC over the exact body bytes (golden)', () => {
    const body = JSON.stringify({ ref: 'refs/heads/main', before: '1'.repeat(40), after: '2'.repeat(40) });
    const sig = '2e207841b69169a7e35a62453b5db206f6d756734420644380fdd28c21f3cc0a';
    expect(verifyGiteaSignature('whsec_gitea', body, sig)).toBe(true);
    expect(verifyGiteaSignature('whsec_gitea', `${body} `, sig)).toBe(false); // one byte off
    expect(verifyGiteaSignature('whsec_other', body, sig)).toBe(false);
    expect(verifyGiteaSignature('whsec_gitea', body, undefined)).toBe(false);
  });

  it('push: passes through — ref, sha and changed paths read as for GitHub', () => {
    const g = normalizeGiteaHook('push', PUSH);
    expect(g).toEqual({ event: 'push', body: PUSH });
    expect(parsePushRef('github', PUSH)).toBe('main');
    expect(parseCommitSha('github', PUSH)).toBe('2'.repeat(40));
    expect(pushChangedPaths(PUSH)).toEqual(['swarmy.yaml', 'web/new.ts']);
  });

  it('pull_request: `synchronized` becomes synchronize; open/close map as GitHub', () => {
    const norm = (action: string) => {
      const g = normalizeGiteaHook('pull_request', PR(action));
      return 'body' in g ? parsePrWebhookEvent('github', g.event, g.body) : null;
    };
    expect(norm('opened')).toEqual({ action: 'opened', prNumber: 12, branch: 'feat/cart', commit: '3'.repeat(40) });
    expect(norm('synchronized')?.action).toBe('synchronize');
    expect(norm('reopened')?.action).toBe('opened');
    expect(norm('closed')?.action).toBe('closed');
    expect(norm('label_updated')).toBeNull();
  });

  it('fork protection reads Gitea PR repos', () => {
    expect(isForkPullRequest('gitea', PR('opened'))).toBe(false);
    expect(isForkPullRequest('gitea', PR('opened', { id: 99, full_name: 'mallory/shop' }))).toBe(true);
  });

  it('a deleted branch becomes the push-delete shape; tags and other events are ignored', () => {
    const g = normalizeGiteaHook('delete', { ref: 'feat/cart', ref_type: 'branch', pusher_type: 'user', repository: repo });
    expect(g).toEqual({ event: 'push', body: { ref: 'refs/heads/feat/cart', after: '0'.repeat(40), deleted: true } });
    expect(normalizeGiteaHook('delete', { ref: 'v1.0.0', ref_type: 'tag' })).toEqual({ ignore: 'tag deleted' });
    expect(normalizeGiteaHook('create', { ref: 'feat/x', ref_type: 'branch' })).toEqual({ ignore: 'create' });
    expect(normalizeGiteaHook(undefined, {})).toEqual({ ignore: 'event' });
  });
});
