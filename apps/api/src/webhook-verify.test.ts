import { describe, expect, it } from 'bun:test';
import {
  DeliveryDeduper,
  githubSignature,
  isForkPullRequest,
  parseCommitSha,
  parsePushRef,
  pushChangedPaths,
  verifyGiteaSignature,
  verifySwarmySignature,
  verifyWebhookSignature,
} from './webhook-verify';

const SECRET = 'whsec_test_secret_value';
const BODY = JSON.stringify({ ref: 'refs/heads/main', after: 'deadbeefcafe' });

describe('verifyWebhookSignature — GitHub HMAC', () => {
  it('accepts a correctly-signed payload', () => {
    const sig = githubSignature(SECRET, BODY);
    expect(
      verifyWebhookSignature({ provider: 'github', secret: SECRET, rawBody: BODY, githubSignature: sig }),
    ).toBe(true);
  });

  it('rejects a tampered body', () => {
    const sig = githubSignature(SECRET, BODY);
    expect(
      verifyWebhookSignature({
        provider: 'github',
        secret: SECRET,
        rawBody: BODY + ' ',
        githubSignature: sig,
      }),
    ).toBe(false);
  });

  it('rejects the wrong secret', () => {
    const sig = githubSignature('other-secret', BODY);
    expect(
      verifyWebhookSignature({ provider: 'github', secret: SECRET, rawBody: BODY, githubSignature: sig }),
    ).toBe(false);
  });

  it('rejects a missing signature', () => {
    expect(
      verifyWebhookSignature({ provider: 'github', secret: SECRET, rawBody: BODY, githubSignature: null }),
    ).toBe(false);
  });

  it('rejects an empty secret', () => {
    const sig = githubSignature('', BODY);
    expect(
      verifyWebhookSignature({ provider: 'github', secret: '', rawBody: BODY, githubSignature: sig }),
    ).toBe(false);
  });
});

describe('verifyWebhookSignature — GitLab token', () => {
  it('accepts a matching token', () => {
    expect(
      verifyWebhookSignature({ provider: 'gitlab', secret: SECRET, rawBody: BODY, gitlabToken: SECRET }),
    ).toBe(true);
  });
  it('rejects a mismatched token', () => {
    expect(
      verifyWebhookSignature({ provider: 'gitlab', secret: SECRET, rawBody: BODY, gitlabToken: 'nope' }),
    ).toBe(false);
  });
});

describe('payload parsing', () => {
  it('parses a GitHub push ref + commit', () => {
    const body = { ref: 'refs/heads/main', after: 'abc123' };
    expect(parsePushRef('github', body)).toBe('main');
    expect(parseCommitSha('github', body)).toBe('abc123');
  });
  it('parses a GitLab push ref + commit', () => {
    const body = { ref: 'refs/heads/release', checkout_sha: 'def456' };
    expect(parsePushRef('gitlab', body)).toBe('release');
    expect(parseCommitSha('gitlab', body)).toBe('def456');
  });
  it('strips tag refs', () => {
    expect(parsePushRef('github', { ref: 'refs/tags/v1.2.3' })).toBe('v1.2.3');
  });
  it('returns null when no ref is present', () => {
    expect(parsePushRef('github', {})).toBeNull();
  });
});

describe('git-apps webhook helpers', () => {
  const secret = 'whsec_x';
  const body = '{"ref":"refs/heads/main"}';

  it('verifies Gitea (bare hex) and generic (sha256=) signatures, constant-time', async () => {
    const { createHmac } = await import('node:crypto');
    const hex = createHmac('sha256', secret).update(body).digest('hex');
    expect(verifyGiteaSignature(secret, body, hex)).toBe(true);
    expect(verifyGiteaSignature(secret, body, `sha256=${hex}`)).toBe(false);
    expect(verifySwarmySignature(secret, body, `sha256=${hex}`)).toBe(true);
    expect(verifySwarmySignature(secret, body, null)).toBe(false);
    expect(verifySwarmySignature('', body, `sha256=${hex}`)).toBe(false);
  });

  it('detects fork PRs and fails closed on unknown shapes', () => {
    const pr = (head: object | null, base: object) => ({ pull_request: { head: { repo: head }, base: { repo: base } } });
    expect(isForkPullRequest('github', pr({ id: 1 }, { id: 1 }))).toBe(false);
    expect(isForkPullRequest('github', pr({ id: 2 }, { id: 1 }))).toBe(true);
    expect(isForkPullRequest('github', pr(null, { id: 1 }))).toBe(true);
    expect(isForkPullRequest('gitlab', { object_attributes: { source_project_id: 5, target_project_id: 5 } })).toBe(false);
    expect(isForkPullRequest('gitlab', { object_attributes: { source_project_id: 6, target_project_id: 5 } })).toBe(true);
    expect(isForkPullRequest('gitlab', {})).toBe(true);
  });

  it('collects changed paths from a push, or says unknown', () => {
    expect(
      pushChangedPaths({ commits: [{ added: ['b.ts'], modified: ['a.ts'] }, { removed: ['c.ts'], modified: ['a.ts'] }] }),
    ).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(pushChangedPaths({ commits: [] })).toBeUndefined();
    expect(pushChangedPaths({ commits: [{ added: ['x'] }], forced: true })).toBeUndefined();
    expect(pushChangedPaths({ commits: Array.from({ length: 20 }, () => ({ added: ['x'] })) })).toBeUndefined();
  });

  it('dedupes redelivered webhooks within the TTL', () => {
    const d = new DeliveryDeduper(1000, 3);
    expect(d.firstSeen('a', 0)).toBe(true);
    expect(d.firstSeen('a', 10)).toBe(false);
    expect(d.firstSeen('a', 2000)).toBe(true); // expired → fresh
    expect(d.firstSeen(null)).toBe(true);
  });
});
