import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// QA-001: the installer hands the controller every address this host answers
// on, so sign-in works from any of them (not only LOGIN_URL).
const ROOT = path.resolve(import.meta.dir, '../../../..');
const SCRIPT = path.join(ROOT, 'scripts/install-swarmy.sh');

function sh(expr: string, env: Record<string, string> = {}): { out: string; code: number } {
  const r = Bun.spawnSync(['bash', '-c', `. "$0"; ${expr}`, SCRIPT], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
  });
  return { out: r.stdout.toString(), code: r.exitCode ?? -1 };
}

describe('install-swarmy.sh host_addresses', () => {
  it('every non-loopback IPv4 of the host plus the public IP, deduped, in order', () => {
    const r = sh('host_addresses 46.101.22.121', {
      SWARMY_HOST_ADDRESSES: '10.0.0.5 172.17.0.1 127.0.0.1 169.254.9.9 100.92.1.7 fe80::1 10.0.0.5',
    });
    expect(r).toEqual({ out: '10.0.0.5 172.17.0.1 100.92.1.7 46.101.22.121\n', code: 0 });
  }, 30_000);

  it('nothing detected is an empty list, not a failure (set -e safe)', () => {
    expect(sh('host_addresses ""; echo "rc=$?"', { SWARMY_HOST_ADDRESSES: '' }).out).toBe('rc=0\n');
  }, 30_000);

  it('is passed to the stack deploy and through to the controller', () => {
    expect(readFileSync(SCRIPT, 'utf8')).toContain('SWARMY_DIRECT_HOSTS="$(host_addresses "${PUBLIC_IP:-}")" \\');
    const stack = readFileSync(path.join(ROOT, 'deploy/swarmy.lite.stack.yml'), 'utf8');
    expect(stack).toContain('\n      SWARMY_DIRECT_HOSTS: ${SWARMY_DIRECT_HOSTS:-}\n');
  });
});
