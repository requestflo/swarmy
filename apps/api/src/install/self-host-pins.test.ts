import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RELEASE_STACK_EOF, renderReleasePins, stampInstallSwarmy } from './self-host-pins';

/**
 * Security review M14: the self-host installer pins the controller + agent to
 * its release (tag@digest, from the BOM-built platform.json) and carries the
 * release's stack file. Overrides warn; an older installer never rolls a newer
 * running platform back; a checked-in (non-release) script warns that it floats.
 */
const ROOT = path.resolve(import.meta.dir, '../../../..');
const SCRIPT_PATH = path.join(ROOT, 'scripts/install-swarmy.sh');
const SCRIPT = readFileSync(SCRIPT_PATH, 'utf8');
const STACK = readFileSync(path.join(ROOT, 'deploy/swarmy.lite.stack.yml'), 'utf8');
const D1 = `sha256:${'1'.repeat(64)}`;
const D2 = `sha256:${'2'.repeat(64)}`;
const PINS = {
  version: '1.2.0',
  commit: 'abc1234',
  controllerImage: `ghcr.io/requestflo/swarmy-controller:1.2.0@${D1}`,
  agentImage: `ghcr.io/requestflo/swarmy-agent:1.2.0@${D2}`,
};

function withStamped<T>(fn: (file: string, dir: string) => T): T {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'swarmy-pins-'));
  try {
    const file = path.join(dir, 'install-swarmy.sh');
    writeFileSync(file, stampInstallSwarmy(SCRIPT, PINS, STACK));
    return fn(file, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Source SCRIPT (with installer args), then run expr. */
function sh(script: string, expr: string, opts: { args?: string[]; env?: Record<string, string> } = {}) {
  const r = Bun.spawnSync(['bash', '-c', `. "$0" "$@"; ${expr}`, script, ...(opts.args ?? [])], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...opts.env },
  });
  return { out: r.stdout.toString(), err: r.stderr.toString(), code: r.exitCode ?? -1 };
}

describe('release pins block (stamped by scripts/stamp-install-swarmy.ts)', () => {
  it('the checked-in script carries the empty block, exactly once', () => {
    expect(SCRIPT).toContain(`${renderReleasePins(null)}\n`);
    expect(SCRIPT.split('# >>> swarmy release pins').length).toBe(2);
  });

  it('a stamped installer parses, pins both images, and embeds the stack file byte-for-byte', () => {
    withStamped((file) => {
      expect(Bun.spawnSync(['bash', '-n', file]).exitCode).toBe(0);
      expect(sh(file, 'printf "%s|%s|%s" "$RELEASE_VERSION" "$DEFAULT_IMAGE" "$DEFAULT_AGENT_IMAGE"').out).toBe(
        `1.2.0|${PINS.controllerImage}|${PINS.agentImage}`,
      );
      expect(sh(file, 'printf "%s|%s" "$IMAGE" "$AGENT_IMAGE"').out).toBe(`${PINS.controllerImage}|${PINS.agentImage}`);
      expect(sh(file, 'release_stack').out).toBe(STACK);
    });
  }, 30_000);

  it('write_stack_file uses the embedded stack file (no fetch, no checkout copy)', () => {
    withStamped((file, dir) => {
      const fetchLog = path.join(dir, 'fetched');
      const curlStub = `curl() { echo "$*" >> ${fetchLog}; return 1; }`;
      const r = sh(file, `STATE_DIR=${dir}; ${curlStub}; f="$(write_stack_file)"; cat "$f"`);
      expect(r.code).toBe(0);
      expect(r.out).toBe(STACK);
      expect(() => readFileSync(fetchLog)).toThrow(); // nothing was fetched
      // SWARMY_REF is an explicit override: the stack file is fetched from it instead.
      const o = sh(file, `STATE_DIR=${dir}; ${curlStub}; write_stack_file`, { env: { SWARMY_REF: 'v9.9.9' } });
      expect(o.code).not.toBe(0);
      expect(readFileSync(fetchLog, 'utf8')).toContain(
        '-fsSL https://raw.githubusercontent.com/requestflo/swarmy/v9.9.9/deploy/swarmy.lite.stack.yml',
      );
    });
  }, 30_000);

  it('--help prints only the header, never the embedded YAML comments', () => {
    withStamped((file) => {
      const help = Bun.spawnSync(['bash', file, '--help'], { stdout: 'pipe' }).stdout.toString();
      expect(help).toContain('--admin-password-file');
      expect(help).toContain('releases/download/stable/install-swarmy.sh');
      expect(help).not.toContain('Host-mode publish'); // a comment inside the stack file
    });
  }, 30_000);

  it('refuses to stamp anything that would float or break the heredoc', () => {
    expect(() => renderReleasePins({ ...PINS, controllerImage: 'ghcr.io/requestflo/swarmy-controller:latest' }, STACK)).toThrow(/not pinned/);
    expect(() => renderReleasePins({ ...PINS, agentImage: `ghcr.io/requestflo/swarmy-agent@${D2}` }, STACK)).toThrow(/not pinned/);
    expect(() => renderReleasePins({ ...PINS, version: '1.2.0"; rm -rf /; "' }, STACK)).toThrow(/semver/);
    expect(() => renderReleasePins({ ...PINS, commit: '$(id)' }, STACK)).toThrow(/git sha/);
    expect(() => renderReleasePins(PINS, '')).toThrow(/empty/);
    expect(() => renderReleasePins(PINS, `a: 1\n${RELEASE_STACK_EOF}\nb: 2\n`)).toThrow(/delimiter/);
    expect(() => stampInstallSwarmy('#!/bin/bash\necho no block\n', PINS, STACK)).toThrow(/no release pins block/);
  });
});

describe('release pins at run time', () => {
  it('semver_newer orders releases and edge pre-releases', () => {
    const newer = (a: string, b: string) => sh(SCRIPT_PATH, `semver_newer ${a} ${b}`).code === 0;
    expect(newer('1.3.0', '1.2.9')).toBe(true);
    expect(newer('1.2.10', '1.2.9')).toBe(true);
    expect(newer('2.0.0', '1.99.99')).toBe(true);
    expect(newer('1.2.0', '1.2.0')).toBe(false);
    expect(newer('1.2.0', '1.3.0')).toBe(false);
    expect(newer('1.2.4', '1.2.4-edge.9')).toBe(true); // the release beats its edge builds
    expect(newer('1.2.4-edge.9', '1.2.4')).toBe(false);
    expect(newer('1.2.4-edge.10', '1.2.4-edge.9')).toBe(true);
    expect(newer('1.2.4-edge.9', '1.2.3')).toBe(true);
    expect(newer('1.2.0+build.5', '1.2.0')).toBe(false);
    expect(newer('dev', '1.0.0')).toBe(false);
    expect(newer('1.0.0', '0.0.0')).toBe(true);
  }, 30_000);

  it('a non-release (checked-in) script warns that it floats, unless both images are given', () => {
    const floats = sh(SCRIPT_PATH, 'apply_release_pins');
    expect(floats.code).toBe(0);
    expect(floats.err).toContain('not a release build');
    const pinned = sh(SCRIPT_PATH, 'apply_release_pins', { args: ['--image', 'reg/c:1', '--agent-image', 'reg/a:1'] });
    expect(pinned.err).not.toContain('not a release build');
  }, 30_000);

  it('a stamped installer warns when --image/--agent-image/SWARMY_REF override its pins', () => {
    withStamped((file) => {
      const onPin = sh(file, 'docker() { return 1; }; apply_release_pins; printf %s "$IMAGE"');
      expect(onPin).toMatchObject({ out: PINS.controllerImage, err: '', code: 0 });
      const r = sh(file, 'docker() { return 1; }; apply_release_pins', { args: ['--image', 'my/controller:dev', '--agent-image', 'my/agent:dev'], env: { SWARMY_REF: 'main' } });
      expect(r.err).toContain("overrides release 1.2.0's pinned controller");
      expect(r.err).toContain("overrides release 1.2.0's pinned agent");
      expect(r.err).toContain('not the one release 1.2.0 ships with');
    });
  }, 30_000);

  it('never rolls a newer running controller (and its agent) back to the installer release', () => {
    withStamped((file) => {
      const stubs =
        `docker() { case "$1 $2" in "service inspect") [ "\${4:-}" = -f ] && echo "ghcr.io/requestflo/swarmy-controller@${D2}"; return 0 ;; ` +
        `"inspect swarmy-agent") echo "ghcr.io/requestflo/swarmy-agent:1.3.0"; return 0 ;; esac; return 1; }; `;
      const newer = sh(file, `${stubs}curl() { printf '{"version":"1.3.0","protocolVersion":3}'; }; apply_release_pins; printf '%s|%s' "$IMAGE" "$AGENT_IMAGE"`);
      expect(newer.out).toBe(`ghcr.io/requestflo/swarmy-controller@${D2}|ghcr.io/requestflo/swarmy-agent:1.3.0`);
      expect(newer.err).toContain('already runs 1.3.0, newer than');
      // An older (or the same) running controller upgrades to the pin.
      const older = sh(file, `${stubs}curl() { printf '{"version":"1.1.0"}'; }; apply_release_pins; printf '%s' "$IMAGE"`);
      expect(older.out).toBe(PINS.controllerImage);
      // An explicit --image is the operator's call: no guard.
      const forced = sh(file, `${stubs}curl() { printf '{"version":"1.3.0"}'; }; apply_release_pins; printf '%s' "$IMAGE"`, {
        args: ['--image', PINS.controllerImage],
      });
      expect(forced.out).toBe(PINS.controllerImage);
    });
  }, 30_000);

  it('only an operator-chosen image is remembered; an old floating default yields to the pin', () => {
    withStamped((file, dir) => {
      const st = path.join(dir, 'install');
      const run = (stateEnv: string, args: string[] = []) =>
        sh(
          file,
          `STATE_DIR=${st}; STATE_FILE=${st}/state.env; mkdir -p ${st}; printf '%s' "$SEED" > ${st}/state.env; remember_settings; ` +
            `printf '%s|%s|' "$IMAGE" "$AGENT_IMAGE"; explicit AGENT_IMAGE && printf 'agent-explicit|'; grep -E '^CFG_(AGENT_)?IMAGE=' ${st}/state.env | tr '\\n' '|'`,
          { args, env: { SEED: stateEnv } },
        );
      const legacy = run('CFG_IMAGE=ghcr.io/requestflo/swarmy-controller:latest\nCFG_AGENT_IMAGE=my/agent:1\n');
      expect(legacy.code).toBe(0);
      expect(legacy.out).toBe(`${PINS.controllerImage}|my/agent:1|agent-explicit|CFG_IMAGE=''|CFG_AGENT_IMAGE=my/agent:1|`);
      const fresh = run('');
      expect(fresh.out).toBe(`${PINS.controllerImage}|${PINS.agentImage}|CFG_IMAGE=''|CFG_AGENT_IMAGE=''|`);
      const flag = run('', ['--image', 'my/controller:2']);
      expect(flag.out).toBe(`my/controller:2|${PINS.agentImage}|CFG_IMAGE=my/controller:2|CFG_AGENT_IMAGE=''|`);
    });
  }, 30_000);
});
