import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Platform-upgrade trust settings must reach the controller: the installer
// takes them as flags/env and passes them through the stack file.
const ROOT = path.resolve(import.meta.dir, '../../../..');
const SCRIPT = path.join(ROOT, 'scripts/install-swarmy.sh');
const STACK = path.join(ROOT, 'deploy/swarmy.lite.stack.yml');
const PEM = '-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEabc\n-----END PUBLIC KEY-----';

function sh(expr: string, env: Record<string, string> = {}): { out: string; err: string; code: number } {
  const r = Bun.spawnSync(['bash', '-c', `. "$0"; ${expr}`, SCRIPT], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
  });
  return { out: r.stdout.toString(), err: r.stderr.toString(), code: r.exitCode ?? -1 };
}

describe('install-swarmy.sh release pubkey + platform feed', () => {
  it('release_pubkey_value accepts the PEM itself or a file holding it', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'swarmy-pub-'));
    try {
      const f = path.join(dir, 'cosign.pub');
      writeFileSync(f, `${PEM}\n`);
      expect(sh(`release_pubkey_value "$K"`, { K: PEM }).out).toBe(PEM);
      expect(sh(`release_pubkey_value "${f}"`).out).toBe(PEM);
      expect(sh('release_pubkey_value "not a key"').code).not.toBe(0);
      expect(sh('release_pubkey_value ""')).toMatchObject({ out: '', code: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('platform_feed_url_ok takes an http(s) base or nothing', () => {
    expect(sh('platform_feed_url_ok https://mirror.lan/swarmy').code).toBe(0);
    expect(sh('platform_feed_url_ok http://10.0.0.5:8080/feed/').code).toBe(0);
    expect(sh('platform_feed_url_ok ""').code).toBe(0);
    expect(sh('platform_feed_url_ok ftp://x').code).not.toBe(0);
    expect(sh('platform_feed_url_ok "https://a b"').code).not.toBe(0);
  });

  it('env is read (a file path resolves to the PEM); bad values refuse before anything runs', () => {
    expect(sh('printf %s "$RELEASE_PUBKEY|$PLATFORM_FEED_URL"', {
      SWARMY_RELEASE_PUBKEY: PEM,
      SWARMY_PLATFORM_FEED_URL: 'https://mirror.lan/swarmy',
    }).out).toBe(`${PEM}|https://mirror.lan/swarmy`);
    const bad = sh('echo unreachable', { SWARMY_RELEASE_PUBKEY: '/nonexistent/cosign.pub' });
    expect(bad.code).not.toBe(0);
    expect(bad.err).toContain('must be a PEM public key');
    expect(sh('echo unreachable', { SWARMY_PLATFORM_FEED_URL: 'mirror.lan' }).code).not.toBe(0);
  });

  it('flags exist, are remembered across re-runs, and are passed to docker stack deploy', () => {
    const script = readFileSync(SCRIPT, 'utf8');
    expect(script).toContain('--release-pubkey) RELEASE_PUBKEY=');
    expect(script).toContain('--platform-feed-url) PLATFORM_FEED_URL=');
    expect(script).toMatch(/for v in [^;]*RELEASE_PUBKEY PLATFORM_FEED_URL; do\n\s+eval "saved=/);
    expect(script).toContain('SWARMY_RELEASE_PUBKEY="$RELEASE_PUBKEY" \\');
    expect(script).toContain('SWARMY_PLATFORM_FEED_URL="$PLATFORM_FEED_URL" \\');
  });

  it('the controller service in the stack file passes both through', () => {
    const stack = readFileSync(STACK, 'utf8');
    // The controller's environment block: between `controller:` and its `ports:`.
    const env = stack.slice(stack.indexOf('\n  controller:'), stack.indexOf('\n    ports:'));
    expect(env).toContain('\n      SWARMY_RELEASE_PUBKEY: ${SWARMY_RELEASE_PUBKEY:-}\n');
    expect(env).toContain('\n      SWARMY_PLATFORM_FEED_URL: ${SWARMY_PLATFORM_FEED_URL:-}\n');
  });
});
