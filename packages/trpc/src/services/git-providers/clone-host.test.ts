import { describe, expect, it } from 'bun:test';
import { remoteHost, remoteMatchesConnection } from './clone-host';
import { installationTokenKey, installationTokenRequest } from './github-token-scope';

describe('M7: a connection token only goes to the connection host', () => {
  it('parses https, ssh:// and scp-style remotes', () => {
    expect(remoteHost('https://GitHub.com/a/b.git')).toEqual({ scheme: 'https', hostname: 'github.com', port: '' });
    expect(remoteHost('ssh://git@gitea.example:2222/a/b.git')).toEqual({ scheme: 'ssh', hostname: 'gitea.example', port: '2222' });
    expect(remoteHost('git@gitlab.com:group/proj.git')).toEqual({ scheme: 'ssh', hostname: 'gitlab.com', port: '' });
    expect(remoteHost('file:///etc/passwd')).toBeNull();
    expect(remoteHost('/srv/repo.git')).toBeNull();
  });

  it('matches the same host and refuses every other one', () => {
    const gh = 'https://github.com';
    expect(remoteMatchesConnection('https://github.com/northwind/shop.git', gh)).toBe(true);
    expect(remoteMatchesConnection('git@github.com:northwind/shop.git', gh)).toBe(true);
    expect(remoteMatchesConnection('https://evil.example/northwind/shop.git', gh)).toBe(false);
    // userinfo / fragment tricks resolve to the real host
    expect(remoteMatchesConnection('https://github.com@evil.example/x.git', gh)).toBe(false);
    expect(remoteMatchesConnection('https://evil.example#@github.com/x.git', gh)).toBe(false);
    expect(remoteMatchesConnection('https://github.com.evil.example/x.git', gh)).toBe(false);
    // the token never crosses in clear, and another port is another service
    expect(remoteMatchesConnection('http://github.com/a/b.git', gh)).toBe(false);
    expect(remoteMatchesConnection('https://github.com:8443/a/b.git', gh)).toBe(false);
    expect(remoteMatchesConnection('https://gitea.lan:3000/a/b.git', 'http://gitea.lan:3000')).toBe(true);
    expect(remoteMatchesConnection('http://gitea.lan:3000/a/b.git', 'http://gitea.lan:3000')).toBe(true);
    expect(remoteMatchesConnection('not a url', gh)).toBe(false);
  });
});

describe('M7: GitHub installation tokens are least-privilege', () => {
  it('narrows to the one repository and the job’s permissions', () => {
    expect(installationTokenRequest({ access: 'read', repo: 'northwind/shop' })).toEqual({
      repositories: ['shop'],
      permissions: { contents: 'read', metadata: 'read' },
    });
    expect(installationTokenRequest({ access: 'feedback', repo: 'northwind/shop.git' })).toEqual({
      repositories: ['shop'],
      permissions: { checks: 'write', statuses: 'write', pull_requests: 'write', metadata: 'read' },
    });
    // The repo picker lists the installation: metadata only, never contents.
    expect(installationTokenRequest({ access: 'list' })).toEqual({ permissions: { metadata: 'read' } });
  });

  it('never widens a repo-scoped token to the whole installation', () => {
    expect(() => installationTokenRequest({ access: 'read' })).toThrow('needs the repository name');
    expect(() => installationTokenRequest({ access: 'read', repo: 'a/b c' })).toThrow();
  });

  it('caches per installation × repo × permissions', () => {
    const read = installationTokenRequest({ access: 'read', repo: 'o/shop' });
    const fb = installationTokenRequest({ access: 'feedback', repo: 'o/shop' });
    expect(installationTokenKey('c1', read)).toBe('c1|shop|contents:read,metadata:read');
    expect(installationTokenKey('c1', fb)).not.toBe(installationTokenKey('c1', read));
    expect(installationTokenKey('c1', installationTokenRequest({ access: 'list' }))).toBe('c1|*|metadata:read');
  });
});
