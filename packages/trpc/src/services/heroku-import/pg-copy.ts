/**
 * The one-shot Heroku → managed Postgres copy, PURE (the golden test pins
 * it). A `container.runOnce` in the primary's own image (its pg_dump and
 * pg_restore match the server), on the cluster's private network, streams
 * `pg_dump -Fc` from Heroku (TLS required) straight into `pg_restore`.
 *
 * Both passwords ride one 0600 libpq passfile put in before start — never
 * argv, never container env. The copy only goes into an EMPTY database: it
 * checks first and stops without touching anything if there are tables.
 */
import { PG_ONESHOT_PASSFILE, PG_ONESHOT_PASSFILE_PATH } from '@swarmy/core';
import type { RunOncePayload } from '@swarmy/core/protocol';

export interface PgUrl {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

const SAFE = /^[A-Za-z0-9._-]{1,255}$/;

/** `postgres://user:pw@host:5432/db?sslmode=require` → its parts; null unless every part is plain. */
export function parsePgUrl(raw: string): PgUrl | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') return null;
  const part = (s: string): string => {
    try {
      return decodeURIComponent(s);
    } catch {
      return '';
    }
  };
  const out = { host: u.hostname, port: u.port ? Number(u.port) : 5432, user: part(u.username), password: part(u.password), database: part(u.pathname.replace(/^\//, '')) };
  if (![out.host, out.user, out.database].every((s) => SAFE.test(s)) || !out.password) return null;
  return Number.isInteger(out.port) && out.port > 0 && out.port < 65536 ? out : null;
}

const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/:/g, '\\:');

/** The source's own line first (first match wins), then any host for the target's superuser. */
export function copyPassfile(src: PgUrl, targetPassword: string): string {
  const line = (fields: string[]): string => `${fields.join(':')}\n`;
  return line([esc(src.host), String(src.port), esc(src.database), esc(src.user), esc(src.password)]) + line(['*', '*', '*', 'postgres', esc(targetPassword)]);
}

const TABLES = `SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')`;

/** bash (for PIPESTATUS): check empty → dump | restore → count. One `SWARMY_COPY` line says how it went. */
export const HEROKU_COPY_SCRIPT = [
  'set -u',
  'SRC="host=$SRC_HOST port=$SRC_PORT dbname=$SRC_DB user=$SRC_USER sslmode=require"',
  'DST="host=$DST_HOST port=5432 dbname=$DST_DB user=postgres sslmode=disable"',
  `n=$(psql "$DST" -w -tA -v ON_ERROR_STOP=1 -c "${TABLES}") || { echo "SWARMY_COPY stage=target"; exit 3; }`,
  'if [ "$n" != "0" ]; then echo "SWARMY_COPY stage=not-empty tables=$n"; exit 4; fi',
  'pg_dump "$SRC" -w -Fc --no-owner --no-acl | pg_restore -w --no-owner --no-acl -d "$DST"',
  's=("${PIPESTATUS[@]}")',
  `t=$(psql "$DST" -w -tA -c "${TABLES}")`,
  'echo "SWARMY_COPY stage=done dump=${s[0]} restore=${s[1]} tables=${t:-0}"',
  '[ "${s[0]}" = 0 ] || exit 5',
].join('\n');

export const COPY_TIMEOUT_MS = 60 * 60_000;

export function herokuCopyPayload(input: {
  image: string;
  network: string;
  primaryService: string;
  database: string;
  src: PgUrl;
  targetPassword: string;
}): Omit<RunOncePayload, 'commandId'> {
  return {
    image: input.image,
    entrypoint: ['/bin/bash', '-c'],
    cmd: [HEROKU_COPY_SCRIPT],
    env: {
      SRC_HOST: input.src.host,
      SRC_PORT: String(input.src.port),
      SRC_DB: input.src.database,
      SRC_USER: input.src.user,
      DST_HOST: input.primaryService,
      DST_DB: input.database,
      PGPASSFILE: PG_ONESHOT_PASSFILE_PATH,
    },
    secretFiles: [{ ...PG_ONESHOT_PASSFILE, contents: copyPassfile(input.src, input.targetPassword), mode: 0o600, uid: 0, gid: 0 }],
    networks: [input.network],
    user: '0:0',
    pull: false,
    timeoutMs: COPY_TIMEOUT_MS,
  };
}

export interface CopyOutcome {
  status: 'copied' | 'copied-with-errors' | 'not-empty' | 'failed';
  tables: number | null;
  /** Plain words for the page. */
  say: string;
}

/** The run's exit code + output → what happened, in plain words. */
export function readCopyOutcome(res: { exitCode: number; output: string; timedOut?: boolean }, cluster: string): CopyOutcome {
  const line = /SWARMY_COPY stage=(\S+)(?: dump=(\d+) restore=(\d+))? tables=(\d+)/.exec(res.output) ?? /SWARMY_COPY stage=(\S+)/.exec(res.output);
  const tables = line?.[4] !== undefined ? Number(line[4]) : null;
  const tail = res.output.trim().split('\n').filter((l) => !l.startsWith('SWARMY_COPY')).slice(-3).join(' ').slice(0, 400);
  if (res.timedOut) return { status: 'failed', tables, say: `The copy ran past an hour and was stopped. ${cluster} may hold part of the data: use the manual steps for a database this size.` };
  if (line?.[1] === 'not-empty') return { status: 'not-empty', tables, say: `${cluster} already has ${tables ?? 'some'} tables, so nothing was copied. The copy only goes into an empty database.` };
  if (line?.[1] === 'done' && res.exitCode === 0) {
    return line[3] === '0'
      ? { status: 'copied', tables, say: `Copied: ${cluster} now has ${tables} tables from Heroku.` }
      : { status: 'copied-with-errors', tables, say: `Copied with errors pg_restore skipped past: ${cluster} has ${tables} tables. Check them before you switch over. ${tail}`.trim() };
  }
  if (/server version mismatch/i.test(res.output)) {
    return { status: 'failed', tables, say: `Heroku runs a newer Postgres than ${cluster}. Set ${cluster}’s version: in swarmy.yaml to at least Heroku’s, then copy again.` };
  }
  if (line?.[1] === 'done') {
    return { status: 'failed', tables, say: `The copy stopped part way: pg_dump couldn’t finish reading the Heroku database. ${cluster} keeps the ${tables ?? 0} tables that arrived. ${tail}`.trim() };
  }
  const where = line?.[1] === 'target' ? `swarmy couldn’t reach ${cluster}` : 'the copy didn’t start';
  return { status: 'failed', tables, say: `Nothing was copied: ${where}. ${tail}`.trim() };
}
