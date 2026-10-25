import { describe, expect, it } from 'bun:test';
import { RunOncePayload } from '@swarmy/core/protocol';
import { copyPassfile, herokuCopyPayload, HEROKU_COPY_SCRIPT, parsePgUrl, readCopyOutcome } from './pg-copy';

const HEROKU_URL = 'postgres://u8a7b6c5:p%3Aw0rd%5Cx@ec2-1-2-3-4.compute-1.amazonaws.com:5432/d1e2f3?sslmode=require';

describe('the Heroku → managed Postgres copy (pure)', () => {
  it('parses a Heroku DATABASE_URL, and refuses anything that could smuggle shell or conninfo', () => {
    expect(parsePgUrl(HEROKU_URL)).toEqual({ host: 'ec2-1-2-3-4.compute-1.amazonaws.com', port: 5432, user: 'u8a7b6c5', password: 'p:w0rd\\x', database: 'd1e2f3' });
    expect(parsePgUrl('postgresql://u:p@h/db')).toMatchObject({ port: 5432 });
    expect(parsePgUrl('mysql://u:p@h/db')).toBeNull();
    expect(parsePgUrl('postgres://u@h/db')).toBeNull();
    expect(parsePgUrl('postgres://u:p@h/db%20name')).toBeNull();
    expect(parsePgUrl('postgres://u%22x:p@h/db')).toBeNull();
    expect(parsePgUrl('not a url')).toBeNull();
  });

  it('puts both passwords in one passfile, the source line first, colons and backslashes escaped', () => {
    expect(copyPassfile(parsePgUrl(HEROKU_URL)!, 'tgt:pw')).toBe(
      'ec2-1-2-3-4.compute-1.amazonaws.com:5432:d1e2f3:u8a7b6c5:p\\:w0rd\\\\x\n*:*:*:postgres:tgt\\:pw\n',
    );
  });

  it('is a valid runOnce: the primary’s image on the cluster network, no password in env or argv', () => {
    const p = herokuCopyPayload({ image: 'pgvector/pgvector:pg17', network: 'shop_db-net', primaryService: 'shop_db-primary', database: 'app', src: parsePgUrl(HEROKU_URL)!, targetPassword: 'tgtpw' });
    expect(RunOncePayload.safeParse({ commandId: crypto.randomUUID(), ...p }).success).toBe(true);
    expect(p).toMatchObject({ image: 'pgvector/pgvector:pg17', networks: ['shop_db-net'], pull: false, entrypoint: ['/bin/bash', '-c'] });
    expect(p.env).toEqual({ SRC_HOST: 'ec2-1-2-3-4.compute-1.amazonaws.com', SRC_PORT: '5432', SRC_DB: 'd1e2f3', SRC_USER: 'u8a7b6c5', DST_HOST: 'shop_db-primary', DST_DB: 'app', PGPASSFILE: '/tmp/.swarmy-pgpass' });
    const visible = JSON.stringify({ env: p.env, cmd: p.cmd });
    for (const pw of ['w0rd', 'tgtpw']) expect(visible).not.toContain(pw);
  });

  it('checks the target is empty before it dumps, and requires TLS to Heroku', () => {
    const lines = HEROKU_COPY_SCRIPT.split('\n');
    expect(lines.findIndex((l) => l.includes('not-empty'))).toBeLessThan(lines.findIndex((l) => l.startsWith('pg_dump')));
    expect(HEROKU_COPY_SCRIPT).toContain('sslmode=require');
    expect(HEROKU_COPY_SCRIPT).not.toContain('--clean');
  });

  it('says what happened in plain words', () => {
    expect(readCopyOutcome({ exitCode: 0, output: 'SWARMY_COPY stage=done dump=0 restore=0 tables=42' }, 'db')).toEqual({ status: 'copied', tables: 42, say: 'Copied: db now has 42 tables from Heroku.' });
    expect(readCopyOutcome({ exitCode: 0, output: 'pg_restore: warning: errors ignored on restore: 2\nSWARMY_COPY stage=done dump=0 restore=1 tables=40' }, 'db').status).toBe('copied-with-errors');
    expect(readCopyOutcome({ exitCode: 4, output: 'SWARMY_COPY stage=not-empty tables=3' }, 'db')).toMatchObject({ status: 'not-empty', tables: 3 });
    expect(readCopyOutcome({ exitCode: 5, output: 'pg_dump: error: server version mismatch\nSWARMY_COPY stage=done dump=1 restore=1 tables=0' }, 'db').say).toContain('newer Postgres');
    expect(readCopyOutcome({ exitCode: 5, output: 'pg_dump: error: connection refused\nSWARMY_COPY stage=done dump=1 restore=0 tables=7' }, 'db').say).toContain('keeps the 7 tables');
    expect(readCopyOutcome({ exitCode: 3, output: 'psql: could not translate host name\nSWARMY_COPY stage=target' }, 'db').say).toContain('couldn’t reach db');
    expect(readCopyOutcome({ exitCode: 137, output: '', timedOut: true }, 'db').status).toBe('failed');
  });
});
