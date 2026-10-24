import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Security review M14: `--admin-password <p>` puts the owner password on argv
 * (visible to every local user in `ps`, kept in shell history). The installer
 * takes it from a file (`--admin-password-file`, `SWARMY_ADMIN_PASSWORD_FILE`)
 * or stdin (`--admin-password -`); the argv flag still works but warns.
 */
const SCRIPT = path.resolve(import.meta.dir, '../../../../scripts/install-swarmy.sh');

/** Source the script WITH installer args (the arg loop runs; `main` doesn't). */
function sh(args: string[], expr: string, opts: { env?: Record<string, string>; stdin?: string } = {}) {
  const r = Bun.spawnSync(['bash', '-c', `. "$0" "$@"; ${expr}`, SCRIPT, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: opts.stdin === undefined ? 'ignore' : Buffer.from(opts.stdin),
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...opts.env },
  });
  return { out: r.stdout.toString(), err: r.stderr.toString(), code: r.exitCode ?? -1 };
}

function withDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'swarmy-pw-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('install-swarmy.sh admin password sources (M14)', () => {
  it('read_password_file: first line, CR stripped; empty or missing fails', () => {
    withDir((dir) => {
      const f = path.join(dir, 'pw');
      writeFileSync(f, 'hunter2 with spaces\r\nsecond line\n');
      expect(sh([], `read_password_file "${f}"`)).toMatchObject({ out: 'hunter2 with spaces', code: 0 });
      writeFileSync(f, 'no-newline');
      expect(sh([], `read_password_file "${f}"`).out).toBe('no-newline');
      writeFileSync(f, '\n');
      expect(sh([], `read_password_file "${f}"`).code).not.toBe(0);
      expect(sh([], `read_password_file "${dir}/missing"`).code).not.toBe(0);
      expect(sh([], `read_password_file "${dir}"`).code).not.toBe(0);
    });
  }, 30_000);

  it('--admin-password-file and SWARMY_ADMIN_PASSWORD_FILE set the password, with no argv warning', () => {
    withDir((dir) => {
      const f = path.join(dir, 'pw');
      writeFileSync(f, 's3cret\n', { mode: 0o600 });
      const flag = sh(['--admin-password-file', f], 'printf %s "$ADMIN_PASSWORD"');
      expect(flag).toMatchObject({ out: 's3cret', code: 0 });
      expect(flag.err).not.toContain('command line');
      const env = sh([], 'printf %s "$ADMIN_PASSWORD"', { env: { SWARMY_ADMIN_PASSWORD_FILE: f, SWARMY_ADMIN_PASSWORD: 'env-loses' } });
      expect(env.out).toBe('s3cret');
      const bad = sh(['--admin-password-file', `${dir}/missing`], 'echo unreachable');
      expect(bad.code).not.toBe(0);
      expect(bad.err).toContain('no password in');
    });
  }, 30_000);

  it('--admin-password - reads stdin', () => {
    expect(sh(['--admin-password', '-'], 'printf %s "$ADMIN_PASSWORD"', { stdin: 'from-stdin\n' })).toMatchObject({
      out: 'from-stdin',
      code: 0,
    });
    const empty = sh(['--admin-password', '-'], 'echo unreachable', { stdin: '' });
    expect(empty.code).not.toBe(0);
    expect(empty.err).toContain('no password on stdin');
  }, 30_000);

  it('--admin-password - refuses when stdin is the script itself (curl | bash)', () => {
    const r = Bun.spawnSync(['bash', '-s', '--', '--admin-password', '-'], {
      stdin: Buffer.from(readFileSync(SCRIPT)),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain('stdin is this script');
  }, 30_000);

  it('--admin-password <p> still works but warns that argv is visible', () => {
    const r = sh(['--admin-password', 'on-argv'], 'printf %s "$ADMIN_PASSWORD"');
    expect(r).toMatchObject({ out: 'on-argv', code: 0 });
    expect(r.err).toContain('other users on this host can read it');
    expect(sh(['--admin-password', 'x', '--admin-password-file', '/dev/null'], 'echo unreachable').code).not.toBe(0);
  }, 30_000);

  it('--help documents the file and stdin forms', () => {
    const help = readFileSync(SCRIPT, 'utf8');
    expect(help).toContain('#   --admin-password-file <f>');
    expect(help).toContain('#   --admin-password -');
    expect(help).toMatch(/#   --admin-password <p> +SWARMY_ADMIN_PASSWORD\. DISCOURAGED/);
  });
});
