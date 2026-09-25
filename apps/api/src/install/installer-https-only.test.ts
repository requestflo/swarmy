import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// H17: install-swarmy.sh hands out node one-liners that are HTTPS-only, and
// the explicit --allow-insecure-install opt-in reaches the controller.
const ROOT = path.resolve(import.meta.dir, '../../../..');
const SCRIPT = path.join(ROOT, 'scripts/install-swarmy.sh');
const STACK = path.join(ROOT, 'deploy/swarmy.lite.stack.yml');

function sh(expr: string, env: Record<string, string> = {}) {
  const r = Bun.spawnSync(['bash', '-c', `. "$0"; ${expr}`, SCRIPT], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
  });
  return { out: r.stdout.toString(), code: r.exitCode ?? -1 };
}

describe('install-swarmy.sh: node installs over HTTPS only (H17)', () => {
  it('add_node_mode: https works; plain http only with the opt-in', () => {
    expect(sh('add_node_mode https://swarmy.1-2-3-4.sslip.io ""').out).toBe('https');
    expect(sh('add_node_mode http://10.0.0.5:3021 ""').out).toBe('refused');
    expect(sh('add_node_mode http://10.0.0.5:3021 1').out).toBe('insecure');
  });

  it('the opt-in is read from env and the flag, remembered, and passed to the stack', () => {
    expect(sh('printf %s "$ALLOW_INSECURE_INSTALL"', { SWARMY_ALLOW_INSECURE_INSTALL: '1' }).out).toBe('1');
    expect(sh('explicit ALLOW_INSECURE_INSTALL && echo yes', { SWARMY_ALLOW_INSECURE_INSTALL: '1' }).out).toBe('yes\n');
    const script = readFileSync(SCRIPT, 'utf8');
    expect(script).toContain('--allow-insecure-install) ALLOW_INSECURE_INSTALL=1');
    expect(script).toMatch(/for v in [^;]*ALLOW_INSECURE_INSTALL RELEASE_PUBKEY PLATFORM_FEED_URL; do\n\s+eval "saved=/);
    expect(script).toContain('SWARMY_ALLOW_INSECURE_INSTALL="$ALLOW_INSECURE_INSTALL" \\');
    // No more "swap https:// for the http:// address" advice: that URL is refused/redirected now.
    expect(script).not.toContain('swap https://');
    const stack = readFileSync(STACK, 'utf8');
    const env = stack.slice(stack.indexOf('\n  controller:'), stack.indexOf('\n    ports:'));
    expect(env).toContain('\n      SWARMY_ALLOW_INSECURE_INSTALL: ${SWARMY_ALLOW_INSECURE_INSTALL:-}\n');
  });
});
