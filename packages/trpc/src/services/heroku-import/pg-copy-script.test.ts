import { afterAll, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HEROKU_COPY_SCRIPT, readCopyOutcome } from './pg-copy';

/**
 * The copy script against stub psql / pg_dump / pg_restore that record what
 * they were given: proves the empty check, the pipe and the PIPESTATUS line.
 */
const dir = mkdtempSync(join(tmpdir(), 'heroku-copy-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const stub = (name: string, body: string): void => {
  writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
};
// psql: the first call answers TABLES_BEFORE, later ones TABLES_AFTER.
stub('psql', `if [ -f "${dir}/psql.called" ]; then echo "$TABLES_AFTER"; else touch "${dir}/psql.called"; echo "$TABLES_BEFORE"; fi`);
stub('pg_dump', `echo "$@" > "${dir}/dump.args"; echo DUMPDATA; exit "\${DUMP_EXIT:-0}"`);
stub('pg_restore', `echo "$@" > "${dir}/restore.args"; cat > "${dir}/restore.stdin"; exit "\${RESTORE_EXIT:-0}"`);

function run(env: Record<string, string>) {
  rmSync(join(dir, 'psql.called'), { force: true });
  rmSync(join(dir, 'dump.args'), { force: true });
  const p = Bun.spawnSync(['bash', '-c', HEROKU_COPY_SCRIPT], {
    env: { PATH: `${dir}:/usr/bin:/bin`, SRC_HOST: 'ec2.example', SRC_PORT: '5432', SRC_DB: 'd1', SRC_USER: 'u1', DST_HOST: 'shop_db-primary', DST_DB: 'app', ...env },
  });
  return { exitCode: p.exitCode ?? -1, output: `${p.stdout.toString()}${p.stderr.toString()}` };
}

describe('HEROKU_COPY_SCRIPT (stub tools)', () => {
  it('streams pg_dump into pg_restore and reports the table count', () => {
    const r = run({ TABLES_BEFORE: '0', TABLES_AFTER: '12' });
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(dir, 'dump.args'), 'utf8')).toBe('host=ec2.example port=5432 dbname=d1 user=u1 sslmode=require -w -Fc --no-owner --no-acl\n');
    expect(readFileSync(join(dir, 'restore.args'), 'utf8')).toBe('-w --no-owner --no-acl -d host=shop_db-primary port=5432 dbname=app user=postgres sslmode=disable\n');
    expect(readFileSync(join(dir, 'restore.stdin'), 'utf8')).toBe('DUMPDATA\n');
    expect(readCopyOutcome(r, 'db')).toMatchObject({ status: 'copied', tables: 12 });
  });

  it('touches nothing when the target already has tables', () => {
    const r = run({ TABLES_BEFORE: '3', TABLES_AFTER: '3' });
    expect(r.exitCode).toBe(4);
    expect(() => readFileSync(join(dir, 'dump.args'))).toThrow();
    expect(readCopyOutcome(r, 'db').status).toBe('not-empty');
  });

  it('a failing pg_dump fails the run; pg_restore’s skipped errors only warn', () => {
    expect(readCopyOutcome(run({ TABLES_BEFORE: '0', TABLES_AFTER: '0', DUMP_EXIT: '1' }), 'db').status).toBe('failed');
    const warn = run({ TABLES_BEFORE: '0', TABLES_AFTER: '9', RESTORE_EXIT: '1' });
    expect(warn.exitCode).toBe(0);
    expect(readCopyOutcome(warn, 'db')).toMatchObject({ status: 'copied-with-errors', tables: 9 });
  });
});
