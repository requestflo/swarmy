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
 * Credentials: the superuser password (also the replication role's) is a
 * Docker SECRET, `<family>__v<n>` mounted at `/run/secrets/<family>` and named
 * by the member's `swarmy.db.passwordSecret` label. The spec carries only
 * `POSTGRES_PASSWORD_FILE` (the official image's `file_env`) and
 * `SWARMY_PG_REPLICATION_PASSWORD_FILE` — never a value, so `docker service
 * inspect` shows no password. The replication password reaches libpq through
 * a passfile in the container's `/var/run/postgresql` (container-local,
 * regenerated each boot, 0600) — never on the data volume, never copied by
 * `pg_basebackup`, never in argv. Legacy members (plain `POSTGRES_PASSWORD`
 * env, pre-secret) keep booting until the reconcile migrates them.
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
  /** The official image reads the superuser password from this file (`file_env`). */
  passwordFile: 'POSTGRES_PASSWORD_FILE',
  database: 'POSTGRES_DB',
  pgdata: 'PGDATA',
  role: 'SWARMY_PG_ROLE',
  replicationUser: 'SWARMY_PG_REPLICATION_USER',
  replicationPassword: 'SWARMY_PG_REPLICATION_PASSWORD',
  /** The boot layer reads the replication password from this file. */
  replicationPasswordFile: 'SWARMY_PG_REPLICATION_PASSWORD_FILE',
  primaryHost: 'SWARMY_PG_PRIMARY_HOST',
  primaryPort: 'SWARMY_PG_PRIMARY_PORT',
  /** Failover epoch a repointed member rejoins under (see the boot script). */
  rejoin: 'SWARMY_PG_REJOIN',
} as const;

export type PgBootRole = 'primary' | 'replica';

// ── Credential secret (the password is a Docker secret, never spec env) ──────

/** Member label naming the cluster's CURRENT password secret (`<family>__v<n>`). */
export const DB_PASSWORD_SECRET_LABEL = 'swarmy.db.passwordSecret';
/** Secret label: which cluster (`<stack>/<cluster>`) a managed-DB secret belongs to. */
export const DB_SECRET_OF_LABEL = 'swarmy.db.secretOf';
/** Secret label: what it holds — `password` | `url` | `ro-url`. */
export const DB_SECRET_KIND_LABEL = 'swarmy.db.secretKind';

const DOCKER_NAME_MAX = 64;
const FAMILY_MAX = DOCKER_NAME_MAX - '__v'.length - 5;

function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** A family name `<stack>_<cluster><suffix>` that fits Docker's cap with `__v<n>`. */
function familyName(stack: string, cluster: string, suffix: string): string {
  const full = `${stack}_${cluster}${suffix}`;
  if (full.length <= FAMILY_MAX) return full;
  const room = FAMILY_MAX - suffix.length - 9;
  return `${full.slice(0, room)}-${shortHash(full)}${suffix}`;
}

export type DbSecretKind = 'password' | 'url' | 'ro-url';
const KIND_SUFFIX: Record<DbSecretKind, string> = {
  password: '-pg-password',
  url: '-pg-url',
  'ro-url': '-pg-ro-url',
};

/** Family of one of a cluster's managed secrets (password, or an app's rw/ro URL). */
export function dbSecretFamily(stack: string, cluster: string, kind: DbSecretKind): string {
  return familyName(stack, cluster, KIND_SUFFIX[kind]);
}

/** Physical `<family>__v<n>` for one version. */
export function dbSecretName(stack: string, cluster: string, kind: DbSecretKind, version: number): string {
  return `${dbSecretFamily(stack, cluster, kind)}__v${version}`;
}

const PHYSICAL_RE = /^(.+)__v(\d+)$/;

/** `<family>__v<n>` → `{ family, version }`, or null. */
export function parseDbSecretName(name: string): { family: string; version: number } | null {
  const m = PHYSICAL_RE.exec(name);
  if (!m) return null;
  const version = Number.parseInt(m[2]!, 10);
  return Number.isSafeInteger(version) && version >= 1 ? { family: m[1]!, version } : null;
}

/** A managed-DB PASSWORD secret (any version)? */
export function isDbPasswordSecret(name: string): boolean {
  const p = parseDbSecretName(name);
  return Boolean(p && p.family.endsWith(KIND_SUFFIX.password));
}

/** Where a member reads the password: `/run/secrets/<family>` (stable across rotations). */
export function dbPasswordPath(secretName: string): string {
  return `/run/secrets/${parseDbSecretName(secretName)?.family ?? secretName}`;
}

/**
 * Shell expression for the superuser password inside a member container —
 * the mounted secret file, or the legacy env for a not-yet-migrated member.
 * For in-container `exec` scripts; the value never lands in a spec.
 */
export const PG_SUPERUSER_PASSWORD_SH = '${POSTGRES_PASSWORD:-$(cat "${POSTGRES_PASSWORD_FILE:-/dev/null}" 2>/dev/null)}';

/** `PGPASSWORD="<the member's password>"` prefix for an in-container psql. */
export const PG_PASSWORD_FROM_MEMBER = `PGPASSWORD="${PG_SUPERUSER_PASSWORD_SH}"`;

type SecretRefLike = { source: string; target?: string; uid?: string; gid?: string; mode?: number };

/** The structural subset of a member spec {@link applyPgCredential} touches. */
export interface PgCredentialSpecLike {
  env?: Record<string, string>;
  labels?: Record<string, string>;
  secrets?: SecretRefLike[];
}

/** The member's password secret: its label, else a mounted password-secret ref. */
export function pgPasswordSecretOf(
  spec: PgCredentialSpecLike,
  labels?: Record<string, string>,
): string | undefined {
  return (
    labels?.[DB_PASSWORD_SECRET_LABEL] ??
    spec.labels?.[DB_PASSWORD_SECRET_LABEL] ??
    spec.secrets?.find((r) => isDbPasswordSecret(r.source))?.source
  );
}

/**
 * Deliver the member's password as a SECRET FILE: mount the declared
 * `<family>__v<n>` at `/run/secrets/<family>` (replacing any other version),
 * point `POSTGRES_PASSWORD_FILE` + `SWARMY_PG_REPLICATION_PASSWORD_FILE` at it,
 * and drop any plaintext `POSTGRES_PASSWORD` / `SWARMY_PG_REPLICATION_PASSWORD`.
 * No declared secret ⇒ unchanged (a legacy member, migrated by the reconcile).
 * Idempotent; every member spec goes through it via `applyPgMember`.
 */
export function applyPgCredential<S extends PgCredentialSpecLike>(
  spec: S,
  labels?: Record<string, string>,
): S {
  const secret = pgPasswordSecretOf(spec, labels);
  if (!secret) return spec;
  const family = parseDbSecretName(secret)?.family ?? secret;
  const path = `/run/secrets/${family}`;
  const env: Record<string, string> = { ...(spec.env ?? {}) };
  delete env[PG_ENV.password];
  delete env[PG_ENV.replicationPassword];
  env[PG_ENV.passwordFile] = path;
  env[PG_ENV.replicationPasswordFile] = path;
  const secrets: SecretRefLike[] = [
    ...(spec.secrets ?? []).filter((r) => {
      const p = parseDbSecretName(r.source);
      return r.source !== secret && (!p || p.family !== family) && (r.target ?? r.source) !== family;
    }),
    { source: secret, target: family },
  ];
  const out: S = { ...spec, env, secrets };
  if (spec.labels) out.labels = { ...spec.labels, [DB_PASSWORD_SECRET_LABEL]: secret };
  return out;
}

/** Where a one-shot's libpq passfile lands (an existing dir in every image). */
export const PG_ONESHOT_PASSFILE = { dir: '/tmp', name: '.swarmy-pgpass' } as const;
export const PG_ONESHOT_PASSFILE_PATH = `${PG_ONESHOT_PASSFILE.dir}/${PG_ONESHOT_PASSFILE.name}`;

/** PURE: a libpq passfile line matching any host/port/db/user (`\\` and `:` escaped). */
export function pgPassfileLine(password: string): string {
  return `*:*:*:*:${password.replace(/\\/g, '\\\\').replace(/:/g, '\\:')}\n`;
}

/** A member still carrying its password as plain env (pre-secret) — migrate it. */
export function pgNeedsCredentialMigration(env: Record<string, string>, labels: Record<string, string>): boolean {
  return !labels[DB_PASSWORD_SECRET_LABEL] && Boolean(env[PG_ENV.password] || env[PG_ENV.replicationPassword]);
}

/**
 * Promote a standby in place — a superuser SQL call (PG12+), so the exec needs
 * no image-specific `pg_ctl` path and no uid switch. Waits up to 25s and prints
 * `t` once recovery has ended.
 */
export const PG_PROMOTE_SQL = 'SELECT pg_promote(true, 25)';

/** Env for a WRITER member. */
export function pgPrimaryEnv(opts: {
  /** Legacy plain-env password; omitted for a secret-backed member (see applyPgCredential). */
  password?: string;
  database: string;
  replicationUser: string;
  replicationPassword?: string;
}): Record<string, string> {
  return {
    [PG_ENV.role]: 'primary',
    ...(opts.password ? { [PG_ENV.password]: opts.password } : {}),
    [PG_ENV.database]: opts.database,
    [PG_ENV.pgdata]: MANAGED_PG_PGDATA,
    [PG_ENV.replicationUser]: opts.replicationUser,
    ...(opts.replicationPassword ? { [PG_ENV.replicationPassword]: opts.replicationPassword } : {}),
  };
}

/** Env for a streaming STANDBY of `primaryHost`. */
export function pgReplicaEnv(opts: {
  /** Legacy plain-env password; omitted for a secret-backed member (see applyPgCredential). */
  password?: string;
  replicationUser: string;
  replicationPassword?: string;
  primaryHost: string;
  primaryPort: number;
  rejoin?: string;
}): Record<string, string> {
  return {
    [PG_ENV.role]: 'replica',
    ...(opts.password ? { [PG_ENV.password]: opts.password } : {}),
    [PG_ENV.pgdata]: MANAGED_PG_PGDATA,
    [PG_ENV.replicationUser]: opts.replicationUser,
    ...(opts.replicationPassword ? { [PG_ENV.replicationPassword]: opts.replicationPassword } : {}),
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
  // The replication password: its secret file, else the legacy env.
  'SWARMY_RPW="${SWARMY_PG_REPLICATION_PASSWORD:-}"',
  'if [ -z "$SWARMY_RPW" ] && [ -n "${SWARMY_PG_REPLICATION_PASSWORD_FILE:-}" ]; then SWARMY_RPW="$(cat "$SWARMY_PG_REPLICATION_PASSWORD_FILE")"; fi',
  'if [ -n "$SWARMY_RPW" ]; then',
  '  psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER:-postgres}" --dbname postgres \\',
  '    -v u="${SWARMY_PG_REPLICATION_USER:-repl}" -v p="$SWARMY_RPW" <<\'SQL\'',
  "SELECT format('CREATE ROLE %I WITH REPLICATION LOGIN PASSWORD %L', :'u', :'p')",
  '  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :\'u\') \\gexec',
  'SQL',
  'fi',
  'unset SWARMY_RPW',
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
    // The password: its mounted secret file, else the legacy env (never exported).
    'RPW="${SWARMY_PG_REPLICATION_PASSWORD:-}"',
    'if [ -z "$RPW" ] && [ -n "${SWARMY_PG_REPLICATION_PASSWORD_FILE:-}" ]; then RPW="$(cat "$SWARMY_PG_REPLICATION_PASSWORD_FILE")"; fi',
    `printf '*:*:*:%s:%s\\n' "$(esc "$RUSER")" "$(esc "$RPW")" > ${MANAGED_PG_PASSFILE}`,
    'unset RPW',
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
