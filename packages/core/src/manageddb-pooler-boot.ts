/**
 * The managed pooler's BOOT layer: swarmy's own `sh -c` entrypoint over the
 * PgBouncer image (the BOM's `pgbouncer` entry), and the SQL that gives the
 * writer the role PgBouncer logs in as. PURE strings, golden-tested.
 *
 * Auth is PgBouncer's `auth_query`, not a userlist of app passwords. The
 * pooler logs in to the writer as its own role, `swarmy_pooler`, whose
 * password is the pooler's Docker secret (`<stack>_<cluster>-pg-pooler__v<n>`)
 * and never changes when the cluster's password is rotated. For every app
 * login it looks the role's SCRAM verifier up in `pg_shadow` through a
 * SECURITY DEFINER function, checks the client against it, and reuses the
 * client's SCRAM keys to open the server connection. So after a rotation the
 * new password works through the pooler on the very next login, with no
 * restart and nothing copied anywhere: the reason this is the auth chosen.
 *
 * Every boot writes `pgbouncer.ini` + `userlist.txt` (the auth role only)
 * into a 0700 tmp dir from env, validated (no value is interpolated unless it
 * matches its shape). SIGTERM is forwarded as SIGINT, PgBouncer's safe
 * shutdown: in-flight transactions finish, then it exits (the drain a repoint
 * relies on, bounded by the service's stop grace period).
 */
import { POOLER_PORT } from './manageddb-pooler';

/** The role the pooler logs in as (and the schema holding its lookup function). */
export const POOLER_AUTH_USER = 'swarmy_pooler';
/** Most client connections one pooler accepts (a client costs PgBouncer a few KB). */
export const POOLER_MAX_CLIENTS = 1000;
/** Where each boot writes its config (`SWARMY_POOLER_DIR` overrides it, for the script's tests). */
const DIR = '/tmp/swarmy-pgbouncer';

/** Env contract of the pooler service. */
export const POOLER_ENV = {
  host: 'SWARMY_POOLER_HOST',
  port: 'SWARMY_POOLER_PORT',
  mode: 'SWARMY_POOLER_MODE',
  poolSize: 'SWARMY_POOLER_POOL_SIZE',
  maxClients: 'SWARMY_POOLER_MAX_CLIENTS',
  authUser: 'SWARMY_POOLER_AUTH_USER',
  /** The auth role's password file (the mounted secret). */
  authFile: 'SWARMY_POOLER_AUTH_FILE',
} as const;

const INI = [
  '[databases]',
  '* = host=$H port=$P',
  '[pgbouncer]',
  'listen_addr = 0.0.0.0',
  `listen_port = ${POOLER_PORT}`,
  'unix_socket_dir =',
  'auth_type = scram-sha-256',
  'auth_file = $D/userlist.txt',
  'auth_user = $U',
  'auth_dbname = postgres',
  `auth_query = SELECT usename, passwd FROM ${POOLER_AUTH_USER}.lookup(\\$1)`,
  'pool_mode = $M',
  'default_pool_size = $N',
  'max_client_conn = $C',
  // Protocol-level prepared statements survive transaction pooling; SQL PREPARE does not.
  'max_prepared_statements = 200',
  'server_reset_query = DISCARD ALL',
  'ignore_startup_parameters = extra_float_digits',
  'stats_users = $U',
];

/** The pooler's entrypoint (`sh -c`). */
export function poolerBootScript(): string {
  const e = POOLER_ENV;
  return [
    'set -eu',
    'log() { echo "swarmy-pooler: $*" >&2; }',
    `H="\${${e.host}:-}"; P="\${${e.port}:-5432}"; M="\${${e.mode}:-transaction}"`,
    `N="\${${e.poolSize}:-20}"; C="\${${e.maxClients}:-${POOLER_MAX_CLIENTS}}"; U="\${${e.authUser}:-${POOLER_AUTH_USER}}"`,
    'case "$H" in ""|*[!A-Za-z0-9_.-]*) log "SWARMY_POOLER_HOST must be the writer service name"; exit 2;; esac',
    'case "$M" in transaction|session) ;; *) log "unknown pool mode $M"; exit 2;; esac',
    'for v in "$P" "$N" "$C"; do case "$v" in ""|*[!0-9]*) log "port, pool size and client limit must be numbers"; exit 2;; esac; done',
    'case "$U" in ""|*[!a-z0-9_]*) log "bad auth user"; exit 2;; esac',
    `D="\${SWARMY_POOLER_DIR:-${DIR}}"; umask 077; mkdir -p "$D"`,
    `PW="$(cat "\${${e.authFile}}")"`,
    `printf '"%s" "%s"\\n' "$U" "$(printf '%s' "$PW" | sed 's/"/""/g')" > "$D/userlist.txt"`,
    'unset PW',
    'cat > "$D/pgbouncer.ini" <<SWARMY_EOF',
    ...INI,
    'SWARMY_EOF',
    `log "pooling for $H:$P ($M, $N per database)"`,
    'pgbouncer "$D/pgbouncer.ini" &',
    'PID=$!',
    'trap \'log "draining: in-flight transactions finish, then it stops"; kill -INT "$PID" 2>/dev/null || true\' TERM INT',
    'set +e',
    'wait "$PID"; RC=$?',
    'while kill -0 "$PID" 2>/dev/null; do wait "$PID"; RC=$?; done',
    'exit "$RC"',
  ].join('\n');
}

export function poolerBootCommand(): string[] {
  return ['/bin/sh', '-c', poolerBootScript()];
}

/**
 * The container health check: PgBouncer answers on its port (the admin
 * database, so the answer never waits on the writer — an outage of the writer
 * must not get the pooler killed and rescheduled in a loop).
 */
export const POOLER_HEALTH_TEST = ['CMD', 'pg_isready', '-q', '-h', '127.0.0.1', '-p', String(POOLER_PORT), '-U', POOLER_AUTH_USER, '-d', 'pgbouncer'];

/**
 * Run on the WRITER (`sh -c <this> swarmy-pooler <verifier>`, superuser over
 * the local socket): the pooler's role with the given SCRAM verifier as its
 * password, and the lookup function `auth_query` calls. Idempotent. `$1` is a
 * SCRAM-SHA-256 verifier, never a password. The lookup answers for any login
 * role except a replication-only one.
 */
export function poolerRoleScript(): string {
  const u = POOLER_AUTH_USER;
  return [
    'set -e',
    `psql -v ON_ERROR_STOP=1 -U postgres -d postgres -v v="$1" <<'SQL'`,
    `SELECT 'CREATE ROLE ${u} LOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${u}') \\gexec`,
    `SELECT format('ALTER ROLE ${u} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', :'v') \\gexec`,
    `CREATE SCHEMA IF NOT EXISTS ${u};`,
    `REVOKE ALL ON SCHEMA ${u} FROM PUBLIC;`,
    `GRANT USAGE ON SCHEMA ${u} TO ${u};`,
    `CREATE OR REPLACE FUNCTION ${u}.lookup(i_username text, OUT usename name, OUT passwd text)`,
    '  RETURNS record LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog',
    '  AS $f$ SELECT s.usename, s.passwd FROM pg_catalog.pg_shadow s WHERE s.usename = i_username AND (s.usesuper OR NOT s.userepl) $f$;',
    `REVOKE ALL ON FUNCTION ${u}.lookup(text) FROM PUBLIC;`,
    `GRANT EXECUTE ON FUNCTION ${u}.lookup(text) TO ${u};`,
    'SQL',
  ].join('\n');
}

/** Run in the POOLER: its pools from the admin console, `|`-separated with a header. */
export function poolerPoolsScript(): string {
  return `PGPASSWORD="$(cat "\${${POOLER_ENV.authFile}}")" psql -h 127.0.0.1 -p ${POOLER_PORT} -U ${POOLER_AUTH_USER} -d pgbouncer -A -F '|' -P footer=off -c 'SHOW POOLS'`;
}
