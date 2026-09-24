/**
 * Managed Postgres BOOT layer — swarmy's own small entrypoint over the official
 * upstream image, so the managed-DB plane depends on no vendor's repackaging.
 *
 * Engine image: `pgvector/pgvector:pg17` (see `DEFAULT_MANAGED_PG_IMAGE` in
 * `protocol/dbBackup.ts`) — the official `postgres:17` Debian image plus the
 * pgvector extension, built and rebuilt on every upstream `postgres` release
 * by the pgvector project. Everything this file relies on is the OFFICIAL
 * image's contract: `docker-entrypoint.sh`, `/docker-entrypoint-initdb.d`,
 * `POSTGRES_PASSWORD` / `POSTGRES_DB` / `PGDATA`, the `postgres` user + `gosu`,
 * and `VOLUME /var/lib/postgresql/data`. Any image honouring that contract
 * (plain `postgres:17`, a private mirror) works as an override.
 *
 * What swarmy adds, as the service `command` (a `sh -c` script — no custom
 * image to build, sign or mirror):
 *
 *   - primary, first boot → the official initdb, plus an init hook creating the
 *     replication role, a `host replication` pg_hba rule, and the include of
 *     swarmy's generated conf.
 *   - replica, empty PGDATA → wait for the primary, `pg_basebackup -X stream`
 *     into a side directory, verify `PG_VERSION`, rename into place, mark
 *     `standby.signal`. A half-finished clone is never mistaken for data.
 *   - every boot → regenerate `swarmy.conf` (primary_conninfo for a standby,
 *     pointed at the CURRENT `SWARMY_PG_PRIMARY_HOST` — that is how a failover
 *     repoint lands), ensure the includes + pg_hba rule (a promoted replica
 *     inherits them from the clone anyway).
 *   - failover safety (never silently lose data):
 *       · a PROMOTED replica restarting under its old replica spec keeps its
 *         writer data and starts as a writer (the promotion is labels-only; the
 *         spec is not redeployed, see manageddb-reconcile).
 *       · a DEMOTED ex-writer (repointed with a new `SWARMY_PG_REJOIN` epoch)
 *         moves its PGDATA ASIDE to `pgdata.diverged-<utc>` — never deleted —
 *         then re-clones from the new writer. Writes it held that never
 *         replicated stay on disk for the operator.
 *       · a `drill:` epoch (the resilience failover drill's throwaway
 *         promotion) is set aside as `pgdata.drill-<utc>`, keeping only the
 *         latest drill copy so repeated drills cannot fill the volume.
 *       · a primary spec never removes a `standby.signal`: only the failover
 *         worker's explicit `pg_promote()` turns a standby into a writer.
 *
 * Replication credentials: the password rides container env (the managed-DB
 * env tradeoff) and reaches libpq through a passfile in the container's
 * `/var/run/postgresql` (container-local, regenerated each boot, 0600) — never
 * on the data volume, never copied by `pg_basebackup`, never in argv.
 */

/** The data volume mounts at the image's own VOLUME path (no anonymous volume). */
export const MANAGED_PG_ROOT = '/var/lib/postgresql/data';
/** PGDATA is a subdirectory of the volume (the official image's recommended layout). */
export const MANAGED_PG_PGDATA_SUBDIR = 'pgdata';
export const MANAGED_PG_PGDATA = `${MANAGED_PG_ROOT}/${MANAGED_PG_PGDATA_SUBDIR}`;
/** Directory swarmy's postgresql.conf includes (PITR conf mounts here). */
export const MANAGED_PG_CONF_DIR = '/etc/swarmy/postgresql.conf.d';
/** Where the PITR extended conf (Docker config) mounts. */
export const MANAGED_PG_PITR_CONF_TARGET = `${MANAGED_PG_CONF_DIR}/swarmy-pitr.conf`;
/** Container-local libpq passfile holding the replication credential. */
export const MANAGED_PG_PASSFILE = '/var/run/postgresql/swarmy.pgpass';

/** Env contract of a managed member (official POSTGRES_* + swarmy's SWARMY_PG_*). */
export const PG_ENV = {
  password: 'POSTGRES_PASSWORD',
  database: 'POSTGRES_DB',
  pgdata: 'PGDATA',
  role: 'SWARMY_PG_ROLE',
  replicationUser: 'SWARMY_PG_REPLICATION_USER',
  replicationPassword: 'SWARMY_PG_REPLICATION_PASSWORD',
  primaryHost: 'SWARMY_PG_PRIMARY_HOST',
  primaryPort: 'SWARMY_PG_PRIMARY_PORT',
  /** Failover epoch a repointed member rejoins under (see the boot script). */
  rejoin: 'SWARMY_PG_REJOIN',
} as const;

export type PgBootRole = 'primary' | 'replica';

/** The superuser the official image creates (`POSTGRES_USER` unset ⇒ postgres). */
export const MANAGED_PG_SUPERUSER = 'postgres';

/**
 * Promote a standby in place — a superuser SQL call (PG12+), so the exec needs
 * no image-specific `pg_ctl` path and no uid switch. Waits up to 25s and prints
 * `t` once recovery has ended.
 */
export const PG_PROMOTE_SQL = 'SELECT pg_promote(true, 25)';

/** Env for a WRITER member. */
export function pgPrimaryEnv(opts: {
  password: string;
  database: string;
  replicationUser: string;
  replicationPassword: string;
}): Record<string, string> {
  return {
    [PG_ENV.role]: 'primary',
    [PG_ENV.password]: opts.password,
    [PG_ENV.database]: opts.database,
    [PG_ENV.pgdata]: MANAGED_PG_PGDATA,
    [PG_ENV.replicationUser]: opts.replicationUser,
    [PG_ENV.replicationPassword]: opts.replicationPassword,
  };
}

/** Env for a streaming STANDBY of `primaryHost`. */
export function pgReplicaEnv(opts: {
  password: string;
  replicationUser: string;
  replicationPassword: string;
  primaryHost: string;
  primaryPort: number;
  rejoin?: string;
}): Record<string, string> {
  return {
    [PG_ENV.role]: 'replica',
    [PG_ENV.password]: opts.password,
    [PG_ENV.pgdata]: MANAGED_PG_PGDATA,
    [PG_ENV.replicationUser]: opts.replicationUser,
    [PG_ENV.replicationPassword]: opts.replicationPassword,
    [PG_ENV.primaryHost]: opts.primaryHost,
    [PG_ENV.primaryPort]: String(opts.primaryPort),
    ...(opts.rejoin ? { [PG_ENV.rejoin]: opts.rejoin } : {}),
  };
}

/** True when a member's env says it was deployed as a replica (the boot role). */
export function pgBootRole(env: Record<string, string>): PgBootRole {
  return env[PG_ENV.role] === 'replica' ? 'replica' : 'primary';
}

/**
 * The per-boot config helper, written to `/usr/local/bin/swarmy-pg-conf` and
 * called by the entrypoint (as root) and the init hook (as postgres, first
 * boot). `$1` = PGDATA, `$2` = `writer` | `standby` | `keep`.
 */
const CONF_HELPER = [
  '#!/bin/sh',
  'set -eu',
  'D="$1"; MODE="$2"',
  `grep -q "^include_if_exists 'swarmy.conf'" "$D/postgresql.conf" || printf "\\ninclude_if_exists 'swarmy.conf'\\ninclude_dir '${MANAGED_PG_CONF_DIR}'\\n" >> "$D/postgresql.conf"`,
  "grep -q '^host replication all all scram-sha-256' \"$D/pg_hba.conf\" || echo 'host replication all all scram-sha-256' >> \"$D/pg_hba.conf\"",
  'if [ "$MODE" != keep ]; then',
  '  {',
  '    echo "# generated by swarmy on every start - edits are overwritten"',
  "    echo \"wal_keep_size = '512MB'\"",
  '    if [ "$MODE" = standby ]; then',
  `      echo "primary_conninfo = 'host=$SWARMY_PG_PRIMARY_HOST port=\${SWARMY_PG_PRIMARY_PORT:-5432} user=\${SWARMY_PG_REPLICATION_USER:-repl} passfile=${MANAGED_PG_PASSFILE} application_name=$(cat /etc/hostname 2>/dev/null || echo standby)'"`,
  '    fi',
  '  } > "$D/swarmy.conf"',
  'fi',
  'if [ "$(id -u)" = 0 ]; then chown postgres:postgres "$D/swarmy.conf" "$D/postgresql.conf" "$D/pg_hba.conf" 2>/dev/null || true; fi',
].join('\n');

/**
 * First-boot init hook (sourced by the official docker-entrypoint.sh as the
 * postgres user while the temporary server runs): create the replication role
 * from env via psql variables (no SQL built from strings), then the conf.
 */
const INIT_HOOK = [
  '# swarmy: sourced by docker-entrypoint.sh on the first boot of a fresh writer',
  'if [ -n "${SWARMY_PG_REPLICATION_PASSWORD:-}" ]; then',
  '  psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER:-postgres}" --dbname postgres \\',
  '    -v u="${SWARMY_PG_REPLICATION_USER:-repl}" -v p="$SWARMY_PG_REPLICATION_PASSWORD" <<\'SQL\'',
  "SELECT format('CREATE ROLE %I WITH REPLICATION LOGIN PASSWORD %L', :'u', :'p')",
  '  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :\'u\') \\gexec',
  'SQL',
  'fi',
  '/usr/local/bin/swarmy-pg-conf "$PGDATA" writer',
].join('\n');

/**
 * The managed member's entrypoint (`sh -c`). Pure string; golden-tested. Ends
 * by exec'ing the official `docker-entrypoint.sh postgres`, which drops to the
 * postgres user and runs initdb only when PGDATA is empty.
 */
export function pgBootScript(): string {
  return [
    'set -eu',
    `export PGDATA="\${PGDATA:-${MANAGED_PG_PGDATA}}"`,
    'ROOT="$(dirname "$PGDATA")"',
    'ROLE="${SWARMY_PG_ROLE:-primary}"',
    'PHOST="${SWARMY_PG_PRIMARY_HOST:-}"',
    'PPORT="${SWARMY_PG_PRIMARY_PORT:-5432}"',
    'RUSER="${SWARMY_PG_REPLICATION_USER:-repl}"',
    'EPOCH="${SWARMY_PG_REJOIN:-}"',
    'log() { echo "swarmy-pg: $*" >&2; }',
    `mkdir -p "$ROOT" ${MANAGED_PG_CONF_DIR} /var/run/postgresql /docker-entrypoint-initdb.d`,
    'chown postgres:postgres "$ROOT"',
    // The PITR archive volume is fresh + root-owned; archive_command runs as postgres.
    'if [ -d /wal-archive ]; then chown postgres:postgres /wal-archive; fi',
    // Replication credential → container-local passfile (libpq escaping of \ and :).
    'esc() { printf \'%s\' "$1" | sed -e \'s/\\\\/\\\\\\\\/g\' -e \'s/:/\\\\:/g\'; }',
    `printf '*:*:*:%s:%s\\n' "$(esc "$RUSER")" "$(esc "\${SWARMY_PG_REPLICATION_PASSWORD:-}")" > ${MANAGED_PG_PASSFILE}`,
    `chown postgres:postgres ${MANAGED_PG_PASSFILE}; chmod 600 ${MANAGED_PG_PASSFILE}`,
    "cat > /usr/local/bin/swarmy-pg-conf <<'SWARMY_EOF'",
    CONF_HELPER,
    'SWARMY_EOF',
    'chmod 755 /usr/local/bin/swarmy-pg-conf',
    "cat > /docker-entrypoint-initdb.d/00-swarmy.sh <<'SWARMY_EOF'",
    INIT_HOOK,
    'SWARMY_EOF',
    'chmod 644 /docker-entrypoint-initdb.d/00-swarmy.sh',
    // Clone into a side dir, verify, rename: a half-finished copy never becomes PGDATA.
    'clone() {',
    '  if [ -z "$PHOST" ]; then log "a replica needs SWARMY_PG_PRIMARY_HOST"; exit 2; fi',
    '  until pg_isready -q -h "$PHOST" -p "$PPORT"; do log "waiting for $PHOST:$PPORT"; sleep 2; done',
    '  rm -rf "$ROOT/pgdata.clone"',
    '  mkdir -p "$ROOT/pgdata.clone"; chown postgres:postgres "$ROOT/pgdata.clone"; chmod 700 "$ROOT/pgdata.clone"',
    `  log "pg_basebackup from $PHOST:$PPORT"`,
    `  gosu postgres env PGPASSFILE=${MANAGED_PG_PASSFILE} pg_basebackup -h "$PHOST" -p "$PPORT" -U "$RUSER" -w -D "$ROOT/pgdata.clone" -X stream -c fast`,
    '  test -s "$ROOT/pgdata.clone/PG_VERSION" || { log "clone verification failed (PG_VERSION missing)"; exit 4; }',
    // Anything left at PGDATA without PG_VERSION is kept aside, never deleted.
    '  if [ -e "$PGDATA" ] && ! rmdir "$PGDATA" 2>/dev/null; then mv "$PGDATA" "$ROOT/pgdata.incomplete-$(date -u +%Y%m%dT%H%M%SZ)"; fi',
    '  mv "$ROOT/pgdata.clone" "$PGDATA"',
    '  rm -f "$PGDATA/recovery.signal" "$PGDATA/postmaster.pid"',
    '  touch "$PGDATA/standby.signal"; chown postgres:postgres "$PGDATA/standby.signal"',
    '}',
    // A volume from the pre-B5 Bitnami engine keeps its cluster in `data/`: never
    // initdb an EMPTY writer beside it — refuse loudly instead.
    'if [ "$ROLE" = primary ] && [ ! -s "$PGDATA/PG_VERSION" ] && [ -s "$ROOT/data/PG_VERSION" ]; then',
    '  log "refusing to start: $ROOT/data holds a Bitnami-layout cluster and $PGDATA is empty - back it up and restore into a new cluster"; exit 3',
    'fi',
    'if [ "$ROLE" = replica ]; then',
    '  if [ ! -s "$PGDATA/PG_VERSION" ]; then',
    '    clone',
    '  elif [ ! -f "$PGDATA/standby.signal" ]; then',
    '    if [ -n "$EPOCH" ] && [ "$(cat "$PGDATA/swarmy.rejoined" 2>/dev/null || true)" != "$EPOCH" ]; then',
    '      case "$EPOCH" in',
    // A failover DRILL's throwaway promotion: keep only the latest drill copy.
    '        drill:*) rm -rf "$ROOT"/pgdata.drill-*; ASIDE="$ROOT/pgdata.drill-$(date -u +%Y%m%dT%H%M%SZ)";;',
    '        *) ASIDE="$ROOT/pgdata.diverged-$(date -u +%Y%m%dT%H%M%SZ)";;',
    '      esac',
    '      log "writer data rejoining as a standby (epoch $EPOCH): it is KEPT at $ASIDE, re-cloning from $PHOST"',
    '      mv "$PGDATA" "$ASIDE"',
    '      clone',
    '    else',
    '      log "PGDATA holds promoted writer data - starting as a writer (the replica spec predates the promotion)"',
    '    fi',
    '  fi',
    '  if [ -n "$EPOCH" ] && [ -s "$PGDATA/PG_VERSION" ]; then printf \'%s\' "$EPOCH" > "$PGDATA/swarmy.rejoined"; chown postgres:postgres "$PGDATA/swarmy.rejoined"; fi',
    'fi',
    'if [ -s "$PGDATA/PG_VERSION" ]; then',
    '  if [ -f "$PGDATA/standby.signal" ]; then',
    '    if [ -n "$PHOST" ]; then /usr/local/bin/swarmy-pg-conf "$PGDATA" standby',
    '    else log "standby without SWARMY_PG_PRIMARY_HOST - keeping its last primary_conninfo"; /usr/local/bin/swarmy-pg-conf "$PGDATA" keep; fi',
    '  else',
    '    /usr/local/bin/swarmy-pg-conf "$PGDATA" writer',
    '  fi',
    'fi',
    'exec docker-entrypoint.sh postgres',
  ].join('\n');
}

/** The container command every managed Postgres member runs. */
export function pgBootCommand(): string[] {
  return ['/bin/sh', '-c', pgBootScript()];
}

/** The structural subset of `ServiceSpec` the boot layer touches. */
export interface PgBootSpecLike {
  command?: string[];
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Stamp the boot layer onto a managed Postgres member spec: the swarmy
 * entrypoint as `command` (no `args`) and the fixed `PGDATA`. Every spec
 * rebuild — provision, reconcile convergence, failover repoint, PITR
 * apply/strip, storage migration — goes through this (via `applyPgMember`),
 * because the live inventory carries no command: a bare rebuild would silently
 * fall back to the image's default entrypoint.
 */
export function applyPgBoot<S extends PgBootSpecLike>(spec: S): S {
  const out: S = {
    ...spec,
    command: pgBootCommand(),
    env: { ...(spec.env ?? {}), [PG_ENV.pgdata]: MANAGED_PG_PGDATA },
  };
  delete out.args;
  return out;
}
