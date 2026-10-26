import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { POOLER_HEALTH_TEST, poolerBootScript, poolerPoolsScript, poolerRoleScript } from './manageddb-pooler-boot';

/**
 * The pooler's entrypoint, run for real under `sh` with a stub `pgbouncer`
 * on PATH: what it writes (pgbouncer.ini, userlist.txt), what it refuses,
 * and that SIGTERM reaches PgBouncer as SIGINT (its safe shutdown, the drain).
 */

const SECRET = 'pooler-s3cret"pw';

function sandbox(stub: string, shebang = '/bin/sh') {
  const dir = mkdtempSync(path.join(tmpdir(), 'swarmy-pooler-'));
  const bin = path.join(dir, 'bin');
  spawnSync('mkdir', ['-p', bin]);
  writeFileSync(path.join(bin, 'pgbouncer'), `#!${shebang}\n${stub}\n`);
  chmodSync(path.join(bin, 'pgbouncer'), 0o755);
  writeFileSync(path.join(dir, 'auth'), SECRET);
  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    SWARMY_POOLER_DIR: path.join(dir, 'conf'),
    SWARMY_POOLER_HOST: 'shop_main-primary',
    SWARMY_POOLER_MODE: 'transaction',
    SWARMY_POOLER_POOL_SIZE: '25',
    SWARMY_POOLER_AUTH_FILE: path.join(dir, 'auth'),
    OUT: path.join(dir, 'out'),
  };
  return { dir, env };
}

const run = (env: Record<string, string>) => spawnSync('/bin/sh', ['-c', poolerBootScript()], { env, encoding: 'utf8' });

describe('the pooler boot script', () => {
  it('writes the ini (auth_query through the lookup function, the declared mode and size) and a userlist of the auth role only', () => {
    const { env } = sandbox('cp "$1" "$OUT"; echo "argv: $*" >> "$OUT"');
    const r = run(env);
    expect(r.status).toBe(0);
    const ini = readFileSync(env.OUT, 'utf8');
    expect(ini).toContain('* = host=shop_main-primary port=5432\n');
    expect(ini).toContain('auth_type = scram-sha-256\n');
    expect(ini).toContain('auth_user = swarmy_pooler\n');
    expect(ini).toContain('auth_dbname = postgres\n');
    expect(ini).toContain('auth_query = SELECT usename, passwd FROM swarmy_pooler.lookup($1)\n');
    expect(ini).toContain('pool_mode = transaction\ndefault_pool_size = 25\nmax_client_conn = 1000\n');
    expect(ini).toContain('listen_port = 6432\nunix_socket_dir =\n');
    expect(ini).toContain(`auth_file = ${env.SWARMY_POOLER_DIR}/userlist.txt`);
    // The password reaches PgBouncer through the 0600 userlist, never argv.
    expect(ini).toContain(`argv: ${env.SWARMY_POOLER_DIR}/pgbouncer.ini\n`);
    expect(ini).not.toContain('s3cret');
    expect(readFileSync(path.join(env.SWARMY_POOLER_DIR, 'userlist.txt'), 'utf8')).toBe('"swarmy_pooler" "pooler-s3cret""pw"\n');
  });

  it('refuses a host, mode or size that is not its shape, before writing anything', () => {
    for (const [k, v] of [['SWARMY_POOLER_HOST', 'x; rm -rf /'], ['SWARMY_POOLER_MODE', 'statement'], ['SWARMY_POOLER_POOL_SIZE', '2x'], ['SWARMY_POOLER_HOST', '']] as const) {
      const { env } = sandbox('exit 0');
      const r = run({ ...env, [k]: v });
      expect(r.status).toBe(2);
      expect(existsSync(path.join(env.SWARMY_POOLER_DIR, 'pgbouncer.ini'))).toBe(false);
    }
  });

  it('forwards SIGTERM to PgBouncer as SIGINT (safe shutdown: in-flight transactions finish)', async () => {
    // A background job of a non-interactive sh starts with SIGINT ignored; a
    // program that installs its own handler (PgBouncer's libevent, Bun here)
    // still receives it, where a shell `trap` could not.
    const stub = [
      "const { writeFileSync } = require('node:fs');",
      "for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { writeFileSync(process.env.OUT, s); process.exit(s === 'SIGINT' ? 0 : 1); });",
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const { env } = sandbox(stub, process.execPath);
    const child = Bun.spawn(['/bin/sh', '-c', poolerBootScript()], { env });
    await new Promise((r) => setTimeout(r, 1_000));
    child.kill('SIGTERM');
    const code = await child.exited;
    expect(readFileSync(env.OUT, 'utf8').trim()).toBe('SIGINT');
    expect(code).toBe(0);
  }, 15_000);
});

describe('the pooler role on the writer, and its reads', () => {
  it('sets the role from a verifier in $1 through psql variables and installs the lookup, idempotently', () => {
    const s = poolerRoleScript();
    expect(s).toContain(`psql -v ON_ERROR_STOP=1 -U postgres -d postgres -v v="$1" <<'SQL'`);
    expect(s).toContain("SELECT 'CREATE ROLE swarmy_pooler LOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'swarmy_pooler') \\gexec");
    expect(s).toContain("NOREPLICATION PASSWORD %L', :'v') \\gexec");
    expect(s).toContain('SECURITY DEFINER SET search_path = pg_catalog');
    expect(s).toContain('AND (s.usesuper OR NOT s.userepl)');
    expect(s).toContain('REVOKE ALL ON FUNCTION swarmy_pooler.lookup(text) FROM PUBLIC;');
  });

  it('health-checks the admin database, so a writer outage never fails it', () => {
    expect(POOLER_HEALTH_TEST).toEqual(['CMD', 'pg_isready', '-q', '-h', '127.0.0.1', '-p', '6432', '-U', 'swarmy_pooler', '-d', 'pgbouncer']);
    expect(poolerPoolsScript()).toContain("-d pgbouncer -A -F '|' -P footer=off -c 'SHOW POOLS'");
  });
});
