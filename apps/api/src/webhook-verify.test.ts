import { describe, expect, it } from 'bun:test';
import {
  githubSignature,
  parseCommitSha,
  parsePushRef,
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
