import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Security review (Low): the end of the install echoed secrets — the generated
 * admin password and the "Add a node" line with the bootstrap join token (and
 * a reusable mesh key). Install output lands in scrollback, `tee`'d logs, CI
 * and cloud-init logs, so both go to 0600 files in the root-only state dir
 * (where state.env already holds them) and the summary prints only the path.
 */
const SCRIPT = path.resolve(import.meta.dir, '../../../../scripts/install-swarmy.sh');

function sh(expr: string) {
  const r = Bun.spawnSync(['bash', '-c', `. "$0"; ${expr}`, SCRIPT], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  });
  return { out: r.stdout.toString(), err: r.stderr.toString(), code: r.exitCode ?? -1 };
}

const mode = (f: string) => (statSync(f).mode & 0o777).toString(8);

describe('install-swarmy.sh never prints install secrets', () => {
  it('add_node_command renders the loader one-liner', () => {
    expect(sh('add_node_command https://swarmy.example "" swt_ab_cd').out).toBe(
      'curl -fsSL https://swarmy.example/install/loader.sh | SWARMY_JOIN_TOKEN=swt_ab_cd sh -s -- --controller https://swarmy.example',
    );
    expect(sh('add_node_command https://s.x "SWARMY_MESH_SETUP_KEY=k1 " t').out).toBe(
      'curl -fsSL https://s.x/install/loader.sh | SWARMY_MESH_SETUP_KEY=k1 SWARMY_JOIN_TOKEN=t sh -s -- --controller https://s.x',
    );
  }, 30_000);

  it('a generated password and the join line go to 0600 files; the summary shows only their paths', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'swarmy-finalize-'));
    try {
      const st = path.join(dir, 'install');
      const r = sh(
        `STATE_DIR=${st}; STATE_FILE=${st}/state.env; ADMIN_PASSWORD_OUT=${st}/admin-password; ADD_NODE_OUT=${st}/add-node.txt; ` +
          `MESH=none; ADMIN_EMAIL=owner@example.com; ADMIN_PASSWORD='pw-SECRET-1'; GENERATED_PW=1; ` +
          `BOOTSTRAP_JOIN_TOKEN=swt_TOKEN-SECRET; ensure_secrets >/dev/null; ` +
          `BOOTSTRAP_JOIN_TOKEN=swt_TOKEN-SECRET; PUBLIC_URL=https://swarmy.example; LOGIN_URL=http://10.0.0.5:3021; finalize`,
      );
      expect(r.code).toBe(0);
      const printed = r.out + r.err;
      expect(printed).not.toContain('pw-SECRET-1');
      expect(printed).not.toContain('swt_TOKEN-SECRET');
      expect(printed).toContain(`Password:   sudo cat ${st}/admin-password`);
      expect(printed).toContain(`Add a node:  sudo cat ${st}/add-node.txt`);
      expect(readFileSync(`${st}/admin-password`, 'utf8')).toBe('pw-SECRET-1\n');
      expect(readFileSync(`${st}/add-node.txt`, 'utf8')).toBe(
        'curl -fsSL https://swarmy.example/install/loader.sh | SWARMY_JOIN_TOKEN=swt_TOKEN-SECRET sh -s -- --controller https://swarmy.example\n',
      );
      expect(mode(st)).toBe('700');
      expect(mode(`${st}/admin-password`)).toBe('600');
      expect(mode(`${st}/add-node.txt`)).toBe('600');
      expect(readdirSync(st).filter((f) => f.startsWith('.'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('a password the operator chose is neither written out nor printed', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'swarmy-finalize-'));
    try {
      const st = path.join(dir, 'install');
      const r = sh(
        `STATE_DIR=${st}; STATE_FILE=${st}/state.env; ADMIN_PASSWORD_OUT=${st}/admin-password; ADD_NODE_OUT=${st}/add-node.txt; ` +
          `MESH=none; ADMIN_EMAIL=owner; ADMIN_PASSWORD='chosen-SECRET'; ensure_secrets >/dev/null; ` +
          `PUBLIC_URL=http://10.0.0.5:3021; LOGIN_URL=http://10.0.0.5:3021; finalize`,
      );
      expect(r.code).toBe(0);
      expect(r.out + r.err).not.toContain('chosen-SECRET');
      expect(r.out).not.toContain('Password:');
      expect(readdirSync(st)).not.toContain('admin-password');
      // Plain HTTP without the opt-in: no one-liner is handed out at all.
      expect(readdirSync(st)).not.toContain('add-node.txt');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
