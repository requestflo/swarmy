import { describe, expect, it } from 'bun:test';
import { BuildImageMsg, GitBuildSource } from './build';

describe('GitBuildSource (git-apps: exact sha, token user, deploy key)', () => {
  it('accepts an exact sha, token user and ssh key; defaults ref', () => {
    const r = GitBuildSource.safeParse({
      url: 'git@github.com:o/r.git',
      sha: 'a'.repeat(40),
      sshKey: 'k',
      tokenUser: 'oauth2',
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.ref).toBe('main');
  });

  it('rejects a non-hex sha (it reaches a shell on the builder)', () => {
    expect(GitBuildSource.safeParse({ url: 'u', sha: 'HEAD; rm -rf /' }).success).toBe(false);
    expect(GitBuildSource.safeParse({ url: 'u', sha: 'abc' }).success).toBe(false);
  });

  it('round-trips inside a buildImage message', () => {
    const msg = {
      type: 'buildImage',
      payload: {
        commandId: '11111111-2222-3333-4444-555555555555',
        source: { url: 'https://github.com/o/r', sha: 'b'.repeat(64) },
        imageRefs: ['localhost:5000/r@x'],
      },
    };
    const parsed = BuildImageMsg.parse(JSON.parse(JSON.stringify(msg)));
    expect(parsed.payload.source.sha).toBe('b'.repeat(64));
    expect(BuildImageMsg.safeParse({ ...msg, type: 'pruneImages' }).success).toBe(false);
  });
});
