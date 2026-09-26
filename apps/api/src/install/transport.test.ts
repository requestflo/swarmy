import { describe, expect, it } from 'bun:test';
import {
  decideInstallTransport,
  httpsBase,
  insecureInstallAllowed,
  isInstallPath,
  isLoopbackIp,
  isPipedScriptPath,
  isVerifiedBlobPath,
  refusalScript,
  requestIsHttps,
} from './transport';

const base = { search: '', clientIp: '203.0.113.9', publicUrl: null as string | null, allowInsecure: false };

describe('install transport (H17)', () => {
  it('covers every install route and only binary blobs are blobs', () => {
    for (const p of ['/install.sh', '/install/loader.sh', '/install/1.2.0/install.sh', '/install/1.2.0/install.sh.sha256', '/install/bin/linux-x64', '/install/bin/manifest.json', '/install/release/platform.json']) {
      expect(isInstallPath(p)).toBe(true);
    }
    expect(isInstallPath('/installations')).toBe(false);
    expect(isInstallPath('/api/trpc/x')).toBe(false);
    expect(isVerifiedBlobPath('/install/bin/linux-x64')).toBe(true);
    expect(isVerifiedBlobPath('/install/cli/darwin-arm64')).toBe(true);
    expect(isVerifiedBlobPath('/install/bin/linux-x64.sha256')).toBe(false);
    expect(isVerifiedBlobPath('/install/bin/manifest.json')).toBe(false);
    expect(isVerifiedBlobPath('/install/loader.sh')).toBe(false);
  });

  it('HTTPS is served', () => {
    expect(decideInstallTransport({ ...base, pathname: '/install/loader.sh', https: true })).toEqual({ action: 'serve', via: 'https' });
  });

  it('plain HTTP redirects to the HTTPS address, keeping path and query', () => {
    expect(
      decideInstallTransport({ ...base, pathname: '/install/loader.sh', search: '?version=1.2.0', https: false, publicUrl: 'https://swarmy.example.com/' }),
    ).toEqual({ action: 'redirect', location: 'https://swarmy.example.com/install/loader.sh?version=1.2.0' });
    // Even with the insecure opt-in: HTTPS wins when it exists.
    expect(
      decideInstallTransport({ ...base, pathname: '/install/bin/linux-x64', https: false, publicUrl: 'https://s.example.com', allowInsecure: true }).action,
    ).toBe('redirect');
  });

  it('plain HTTP with no HTTPS address is refused, except the node-local bootstrap and the opt-in', () => {
    const r = decideInstallTransport({ ...base, pathname: '/install/loader.sh', https: false, publicUrl: 'http://10.0.0.5:3021' });
    expect(r.action).toBe('refuse');
    if (r.action === 'refuse') {
      expect(r.status).toBe(403);
      expect(r.body).toContain('only served over HTTPS');
      expect(r.body).toContain('--allow-insecure-install');
    }
    expect(decideInstallTransport({ ...base, pathname: '/install/loader.sh', https: false, clientIp: '127.0.0.1' })).toEqual({ action: 'serve', via: 'loopback' });
    expect(decideInstallTransport({ ...base, pathname: '/install/loader.sh', https: false, clientIp: '::ffff:127.0.0.1' }).action).toBe('serve');
    expect(decideInstallTransport({ ...base, pathname: '/install/loader.sh', https: false, allowInsecure: true })).toEqual({
      action: 'serve',
      via: 'insecure-opt-in',
    });
  });

  it('binary blobs stay downloadable without HTTPS (their sha256 is pinned elsewhere); their checksums do not', () => {
    expect(decideInstallTransport({ ...base, pathname: '/install/bin/linux-arm64', https: false })).toEqual({ action: 'serve', via: 'verified-blob' });
    expect(decideInstallTransport({ ...base, pathname: '/install/bin/linux-arm64.sha256', https: false }).action).toBe('refuse');
    expect(decideInstallTransport({ ...base, pathname: '/install/release/platform.json', https: false }).action).toBe('refuse');
  });

  it('only a trusted proxy can say the request was HTTPS', () => {
    const h = new Headers({ 'x-forwarded-proto': 'https' });
    expect(requestIsHttps({ url: 'http://c:3021/install/loader.sh', headers: h, peerIsTrustedProxy: false })).toBe(false);
    expect(requestIsHttps({ url: 'http://c:3021/install/loader.sh', headers: h, peerIsTrustedProxy: true })).toBe(true);
    expect(requestIsHttps({ url: 'http://c/x', headers: new Headers({ forwarded: 'for=1.2.3.4;proto=https' }), peerIsTrustedProxy: true })).toBe(true);
    expect(requestIsHttps({ url: 'http://c/x', headers: new Headers({ 'x-forwarded-proto': 'http' }), peerIsTrustedProxy: true })).toBe(false);
    expect(requestIsHttps({ url: 'https://c/x', headers: new Headers(), peerIsTrustedProxy: false })).toBe(true);
  });

  it('helpers', () => {
    expect(isLoopbackIp('127.4.5.6')).toBe(true);
    expect(isLoopbackIp('[::1]')).toBe(true);
    expect(isLoopbackIp('10.0.0.1')).toBe(false);
    expect(isLoopbackIp(undefined)).toBe(false);
    expect(httpsBase('https://a.example.com:8443/x')).toBe('https://a.example.com:8443');
    expect(httpsBase('http://a.example.com')).toBeNull();
    expect(httpsBase('https://localhost:3021')).toBeNull();
    expect(httpsBase('not a url')).toBeNull();
    expect(insecureInstallAllowed({ NODE_ENV: 'production' })).toBe(false);
    expect(insecureInstallAllowed({ NODE_ENV: 'production', SWARMY_ALLOW_INSECURE_INSTALL: '1' })).toBe(true);
    expect(insecureInstallAllowed({ NODE_ENV: 'development' })).toBe(true);
    expect(insecureInstallAllowed({ NODE_ENV: 'development', SWARMY_ALLOW_INSECURE_INSTALL: 'false' })).toBe(false);
  });

  it('the piped entrypoints get the refusal as a script that only prints and exits 1', () => {
    expect(isPipedScriptPath('/install/loader.sh')).toBe(true);
    expect(isPipedScriptPath('/install.sh')).toBe(true);
    expect(isPipedScriptPath('/install/1.2.0/install.sh')).toBe(false);
    const script = refusalScript("it's refused\nline two\n");
    const r = Bun.spawnSync(['sh', '-c', script]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout.toString()).toBe('');
    expect(r.stderr.toString()).toBe("it's refused\nline two\n");
  }, 30_000);
});
