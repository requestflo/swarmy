/**
 * Pure builders for app-DB logical backups (see `./appDb.ts` for the flow):
 * credential resolution from a service spec, the in-task credential probe, and
 * the dump / load / verify shell scripts each sidecar runs. Golden-tested in
 * `appDbScripts.test.ts`; the agent only wires containers around them.
 *
 * Every script reads its inputs from env (`SWARMY_DB_*`, `SWARMY_MODE`,
 * `SWARMY_SUFFIX`, `SWARMY_DATA_MOUNT`) so the text is constant per engine and
 * a secret never appears in argv of the dump sidecar. MySQL credentials go into
 * an option file on `/dev/shm` (tmpfs — never node disk); Mongo's into a
 * `--config` YAML there. Scripts end with `SWARMY_OUT key=value` lines the
 * agent parses into the command result.
 */
import type { AppDbCredSource, AppDbCreds, AppDbEngine } from './appDb';

/** Where the scratch dump volume mounts in every sidecar (clash-free with DB images' own VOLUMEs). */
export const APPDB_DUMP_MOUNT = '/swarmy-dump';
/** restic `--host` prefix for app-DB snapshots. */
export const APPDB_HOST_PREFIX = 'appdb';

const DEFAULT_PORT: Record<AppDbEngine, number> = {
  mysql: 3306,
  mariadb: 3306,
  postgres: 5432,
  mongo: 27017,
  redis: 6379,
  valkey: 6379,
};

export function isSqlEngine(e: AppDbEngine): e is 'mysql' | 'mariadb' {
  return e === 'mysql' || e === 'mariadb';
}
export function isKvEngine(e: AppDbEngine): e is 'redis' | 'valkey' {
  return e === 'redis' || e === 'valkey';
}

/** The tool the dashboard names for an engine's logical backup. */
export function appDbMethod(e: AppDbEngine): string {
  if (e === 'mysql') return 'mysqldump';
  if (e === 'mariadb') return 'mariadb-dump';
  if (e === 'postgres') return 'pg_dump';
  if (e === 'mongo') return 'mongodump';
  return 'BGSAVE + RDB copy';
}

// ── credential resolution (controller side, from the service spec) ──────────

export type AppDbCredResolution =
  | { ok: true; creds: AppDbCreds; note: string | null }
  | { ok: false; reason: string };

/** `KEY=value` list → record (last wins, like Docker). */
export function envRecordOf(env: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of env) {
    const i = kv.indexOf('=');
    if (i <= 0) continue;
    out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
}

function has(env: Record<string, string>, k: string): boolean {
  return (env[k] ?? '').length > 0;
}

/** For each name: `NAME` (env) and `NAME_FILE` (secret file), in that order, if set. */
function sourcesFor(env: Record<string, string>, names: string[]): AppDbCredSource[] {
  const out: AppDbCredSource[] = [];
  for (const n of names) {
    if (has(env, n)) out.push({ kind: 'env', name: n });
    if (has(env, `${n}_FILE`) && env[`${n}_FILE`]!.startsWith('/')) out.push({ kind: 'file', name: `${n}_FILE` });
  }
  return out;
}

function portFrom(env: Record<string, string>, names: string[], engine: AppDbEngine): number {
  for (const n of names) {
    const p = Number(env[n]);
    if (Number.isInteger(p) && p > 0 && p < 65536) return p;
  }
  return DEFAULT_PORT[engine];
}

function truthy(env: Record<string, string>, names: string[]): boolean {
  return names.some((n) => has(env, n) && !/^(no|false|0)$/i.test(env[n]!));
}

/**
 * How a human would log into this database, read off the service's env —
 * the official images' and bitnami's variables, env or `_FILE` secret. Returns
 * the recipe (never a value) or why it can't be done, in which case the
 * database keeps its crash-consistent volume snapshot only.
 */
export function resolveAppDbCreds(
  engine: AppDbEngine,
  envList: string[],
): AppDbCredResolution {
  const env = envRecordOf(envList);
  if (isSqlEngine(engine)) {
    const maria = engine === 'mariadb';
    const port = portFrom(env, maria ? ['MARIADB_PORT_NUMBER', 'MYSQL_PORT_NUMBER'] : ['MYSQL_PORT_NUMBER'], engine);
    const rootUser: AppDbCredSource[] = [
      ...sourcesFor(env, maria ? ['MARIADB_ROOT_USER', 'MYSQL_ROOT_USER'] : ['MYSQL_ROOT_USER']),
      { kind: 'literal', value: 'root' },
    ];
    const rootPw = sourcesFor(env, maria ? ['MARIADB_ROOT_PASSWORD', 'MYSQL_ROOT_PASSWORD'] : ['MYSQL_ROOT_PASSWORD']);
    if (rootPw.length > 0) {
      return { ok: true, creds: { scope: 'root', user: rootUser, password: rootPw, database: [], authDb: [], port }, note: null };
    }
    const emptyRoot = truthy(
      env,
      maria
        ? ['MARIADB_ALLOW_EMPTY_ROOT_PASSWORD', 'MYSQL_ALLOW_EMPTY_PASSWORD', 'ALLOW_EMPTY_PASSWORD']
        : ['MYSQL_ALLOW_EMPTY_PASSWORD', 'ALLOW_EMPTY_PASSWORD'],
    );
    if (emptyRoot) {
      return {
        ok: true,
        creds: { scope: 'root', user: rootUser, password: [], database: [], authDb: [], port },
        note: 'root has an empty password',
      };
    }
    const user = sourcesFor(env, maria ? ['MARIADB_USER', 'MYSQL_USER'] : ['MYSQL_USER']);
    const userPw = sourcesFor(env, maria ? ['MARIADB_PASSWORD', 'MYSQL_PASSWORD'] : ['MYSQL_PASSWORD']);
    if (user.length > 0 && userPw.length > 0) {
      const database = sourcesFor(env, maria ? ['MARIADB_DATABASE', 'MYSQL_DATABASE'] : ['MYSQL_DATABASE']);
      return {
        ok: true,
        creds: { scope: 'user', user, password: userPw, database, authDb: [], port },
        note: 'dumps as the app user (no root password in the service env)',
      };
    }
    const random = truthy(env, ['MYSQL_RANDOM_ROOT_PASSWORD', 'MARIADB_RANDOM_ROOT_PASSWORD']);
    return {
      ok: false,
      reason: random
        ? 'the root password is random and no MYSQL_USER/MYSQL_PASSWORD is set'
        : 'no MYSQL_ROOT_PASSWORD (or _FILE) or MYSQL_USER/MYSQL_PASSWORD in the service env',
    };
  }

  if (engine === 'postgres') {
    const port = portFrom(env, ['POSTGRESQL_PORT_NUMBER'], engine);
    // Official image: POSTGRES_USER (default postgres) is a superuser.
    const officialPw = sourcesFor(env, ['POSTGRES_PASSWORD']);
    const officialUser: AppDbCredSource[] = [...sourcesFor(env, ['POSTGRES_USER']), { kind: 'literal', value: 'postgres' }];
    if (officialPw.length > 0) {
      return { ok: true, creds: { scope: 'root', user: officialUser, password: officialPw, database: [], authDb: [], port }, note: null };
    }
    if (/^trust$/i.test(env.POSTGRES_HOST_AUTH_METHOD ?? '')) {
      return {
        ok: true,
        creds: { scope: 'root', user: officialUser, password: [], database: [], authDb: [], port },
        note: 'the server trusts every connection (POSTGRES_HOST_AUTH_METHOD=trust)',
      };
    }
    // bitnami: the postgres superuser, else the app user on its database.
    const superPw = sourcesFor(env, ['POSTGRESQL_POSTGRES_PASSWORD']);
    if (superPw.length > 0) {
      return {
        ok: true,
        creds: { scope: 'root', user: [{ kind: 'literal', value: 'postgres' }], password: superPw, database: [], authDb: [], port },
        note: null,
      };
    }
    const bitPw = sourcesFor(env, ['POSTGRESQL_PASSWORD']);
    if (bitPw.length > 0) {
      const username = env.POSTGRESQL_USERNAME ?? '';
      if (!username || username === 'postgres') {
        return {
          ok: true,
          creds: { scope: 'root', user: [{ kind: 'literal', value: 'postgres' }], password: bitPw, database: [], authDb: [], port },
          note: null,
        };
      }
      const database = sourcesFor(env, ['POSTGRESQL_DATABASE']);
      if (database.length > 0) {
        return {
          ok: true,
          creds: { scope: 'user', user: sourcesFor(env, ['POSTGRESQL_USERNAME']), password: bitPw, database, authDb: [], port },
          note: 'dumps as the app user (no postgres superuser password in the service env)',
        };
      }
    }
    return { ok: false, reason: 'no POSTGRES_PASSWORD (or _FILE) / POSTGRESQL_PASSWORD in the service env' };
  }

  if (engine === 'mongo') {
    const port = portFrom(env, ['MONGODB_PORT_NUMBER'], engine);
    const officialPw = sourcesFor(env, ['MONGO_INITDB_ROOT_PASSWORD']);
    const officialUser = sourcesFor(env, ['MONGO_INITDB_ROOT_USERNAME']);
    if (officialPw.length > 0 && officialUser.length > 0) {
      return {
        ok: true,
        creds: { scope: 'root', user: officialUser, password: officialPw, database: [], authDb: [{ kind: 'literal', value: 'admin' }], port },
        note: null,
      };
    }
    const bitnamiPw = sourcesFor(env, ['MONGODB_ROOT_PASSWORD']);
    if (bitnamiPw.length > 0) {
      return {
        ok: true,
        creds: {
          scope: 'root',
          user: [...sourcesFor(env, ['MONGODB_ROOT_USER']), { kind: 'literal', value: 'root' }],
          password: bitnamiPw,
          database: [],
          authDb: [{ kind: 'literal', value: 'admin' }],
          port,
        },
        note: null,
      };
    }
    const appUser = sourcesFor(env, ['MONGODB_USERNAME']);
    const appPw = sourcesFor(env, ['MONGODB_PASSWORD']);
    const appDb = sourcesFor(env, ['MONGODB_DATABASE']);
    if (appUser.length > 0 && appPw.length > 0 && appDb.length > 0) {
      return {
        ok: true,
        creds: { scope: 'user', user: appUser, password: appPw, database: appDb, authDb: appDb, port },
        note: 'dumps as the app user (no root password in the service env)',
      };
    }
    if (officialUser.length > 0 || officialPw.length > 0) {
      return { ok: false, reason: 'only one of MONGO_INITDB_ROOT_USERNAME / _PASSWORD is set' };
    }
    return {
      ok: true,
      creds: { scope: 'none', user: [], password: [], database: [], authDb: [], port },
      note: 'no credentials in the service env — assumes auth is off',
    };
  }

  // redis / valkey: bitnami's env, else the server's own --requirepass / redis.conf.
  const port = portFrom(env, engine === 'valkey' ? ['VALKEY_PORT_NUMBER', 'REDIS_PORT_NUMBER'] : ['REDIS_PORT_NUMBER'], engine);
  const envPw = sourcesFor(env, engine === 'valkey' ? ['VALKEY_PASSWORD', 'REDIS_PASSWORD'] : ['REDIS_PASSWORD']);
  return {
    ok: true,
    creds: {
      scope: 'root',
      user: [],
      password: [...envPw, { kind: 'redis-cmdline' }],
      database: [],
      authDb: [],
      port,
    },
    note: envPw.length > 0 ? null : 'password (if any) read from the server command line / redis.conf',
  };
}

// ── probe (runs INSIDE the task via exec; prints values the agent keeps) ─────

/** Single-quote for POSIX sh. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Redis rewrites its process title, so `/proc/1/cmdline` no longer shows
 * `--requirepass`. The agent reads the container's configured argv (`docker
 * inspect` Config.Entrypoint + Cmd — node-local) with {@link redisArgHints} and
 * hands the probe `SWARMY_REDIS_ARGPW` / `SWARMY_REDIS_CONF` as exec env.
 */
const REDIS_CONF_PW =
  "$( [ -n \"${SWARMY_REDIS_CONF:-}\" ] && [ -r \"$SWARMY_REDIS_CONF\" ] && " +
  "sed -n 's/^[[:space:]]*requirepass[[:space:]][[:space:]]*//p' \"$SWARMY_REDIS_CONF\" | head -n 1 | tr -d '\"' )";

/** `--requirepass <pw>` and a `*.conf` path out of a container's argv (incl. `sh -c "…"` forms). */
export function redisArgHints(argv: string[]): { password?: string; conf?: string } {
  const tokens = argv.flatMap((a) => a.split(/\s+/)).filter(Boolean);
  const out: { password?: string; conf?: string } = {};
  const i = tokens.indexOf('--requirepass');
  if (i >= 0 && tokens[i + 1]) out.password = tokens[i + 1]!.replace(/^["']|["']$/g, '');
  const conf = tokens.find((t) => t.endsWith('.conf') && t.startsWith('/'));
  if (conf) out.conf = conf;
  return out;
}

function sourceLine(s: AppDbCredSource): string {
  switch (s.kind) {
    case 'env':
      return `[ -n "$v" ] || v="\${${s.name}:-}"`;
    case 'file':
      return `[ -n "$v" ] || { [ -n "\${${s.name}:-}" ] && [ -r "\${${s.name}}" ] && v="$(cat "\${${s.name}}")"; }`;
    case 'literal':
      return `[ -n "$v" ] || v=${shq(s.value)}`;
    case 'redis-cmdline':
      return `[ -n "$v" ] || v="\${SWARMY_REDIS_ARGPW:-}"\n[ -n "$v" ] || v="${REDIS_CONF_PW}"`;
  }
}

function fieldBlock(key: string, sources: AppDbCredSource[]): string {
  return ["v=''", ...sources.map(sourceLine), `printf '${key}=%s\\n' "$v"`].join('\n');
}

/** The exec'd probe: resolves each field in-task and prints `SWARMY_DB_*=` lines. */
export function probeScript(creds: AppDbCreds): string {
  return [
    fieldBlock('SWARMY_DB_USER', creds.user),
    fieldBlock('SWARMY_DB_PASSWORD', creds.password),
    fieldBlock('SWARMY_DB_NAME', creds.database),
    fieldBlock('SWARMY_DB_AUTHDB', creds.authDb),
    `printf 'SWARMY_DB_PORT=%s\\n' ${creds.port}`,
    "printf 'SWARMY_PROBE_OK=1\\n'",
  ].join('\n');
}

const PROBE_KEYS = new Set([
  'SWARMY_DB_USER',
  'SWARMY_DB_PASSWORD',
  'SWARMY_DB_NAME',
  'SWARMY_DB_AUTHDB',
  'SWARMY_DB_PORT',
]);

/**
 * Parse the probe's stdout into sidecar env. Only the known keys survive;
 * throws when the trailer is missing (truncated / failed probe).
 */
export function parseProbeOutput(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  let ok = false;
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === 'SWARMY_PROBE_OK=1') ok = true;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const k = line.slice(0, i);
    if (PROBE_KEYS.has(k) && !(k in out)) out[k] = line.slice(i + 1);
  }
  if (!ok) throw new Error('credential probe did not complete');
  return out;
}

/** `SWARMY_OUT key=value` lines → key → values (repeatable keys, e.g. `db`). */
export function parseScriptOutputs(stdout: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const raw of stdout.split('\n')) {
    const m = raw.replace(/\r$/, '').match(/^SWARMY_OUT ([a-z]+)=(.*)$/);
    if (!m) continue;
    (out[m[1]!] ??= []).push(m[2]!);
  }
  return out;
}

// ── scripts ──────────────────────────────────────────────────────────────────

const D = APPDB_DUMP_MOUNT;

const SQL_PRELUDE = [
  'set -eu',
  'umask 077',
  'CLI=$(command -v mariadb || command -v mysql || true)',
  'DUMP=$(command -v mariadb-dump || command -v mysqldump || true)',
  '[ -n "$CLI" ] || { echo "swarmy: no mysql/mariadb client in this image" >&2; exit 3; }',
  '{ [ -d /dev/shm ] && [ -w /dev/shm ]; } || { echo "swarmy: /dev/shm is not writable — refusing to put credentials on disk" >&2; exit 3; }',
  'CNF=/dev/shm/swarmy-my.cnf',
  "trap 'rm -f \"$CNF\"' EXIT",
  String.raw`esc() { printf '%s' "$1" | sed 's/[\\"]/\\&/g'; }`,
  "{ echo '[client]'; printf 'user=\"%s\"\\n' \"$(esc \"${SWARMY_DB_USER:-root}\")\"; " +
    "printf 'password=\"%s\"\\n' \"$(esc \"${SWARMY_DB_PASSWORD:-}\")\"; " +
    "echo 'host=127.0.0.1'; printf 'port=%s\\n' \"${SWARMY_DB_PORT:-3306}\"; } > \"$CNF\"",
  'my() { "$CLI" --defaults-extra-file="$CNF" "$@"; }',
];

const SQL_WAIT = [
  'i=0',
  "until my -e 'SELECT 1' >/dev/null 2>&1; do",
  '  i=$((i+1)); [ "$i" -ge 120 ] && { echo "swarmy: server never became ready" >&2; my -e \'SELECT 1\' >&2 || true; exit 5; }',
  '  sleep 2',
  'done',
];

const SQL_SYSTEM_DBS = '^(information_schema|performance_schema|mysql|sys)$';

function sqlDump(scope: AppDbCreds['scope']): string {
  return [
    ...SQL_PRELUDE,
    '[ -n "$DUMP" ] || { echo "swarmy: no mysqldump/mariadb-dump in this image" >&2; exit 3; }',
    'if [ -n "${SWARMY_DB_NAME:-}" ]; then DBS="$SWARMY_DB_NAME"; else',
    "  ALL=$(my -N -B -e 'SHOW DATABASES')",
    `  DBS=$(printf '%s\\n' "$ALL" | grep -Ev '${SQL_SYSTEM_DBS}' || true)`,
    'fi',
    `: > ${D}/databases.txt`,
    `for d in $DBS; do echo "$d" >> ${D}/databases.txt; done`,
    `OPTS="--single-transaction --routines --triggers --no-tablespaces --hex-blob --add-drop-database${scope === 'root' ? ' --events' : ''}"`,
    "if \"$DUMP\" --help 2>/dev/null | grep -q -- '--set-gtid-purged'; then OPTS=\"$OPTS --set-gtid-purged=OFF\"; fi",
    'if [ -z "$DBS" ]; then',
    `  echo '-- swarmy: no user databases to dump' > ${D}/dump.sql`,
    'else',
    `  "$DUMP" --defaults-extra-file="$CNF" $OPTS --databases $DBS > ${D}/dump.sql`,
    `  tail -c 512 ${D}/dump.sql | grep -q 'Dump completed' || { echo "swarmy: dump ended early (no 'Dump completed' trailer)" >&2; exit 4; }`,
    'fi',
    'echo "SWARMY_OUT tool=$(basename "$DUMP")"',
    'for d in $DBS; do echo "SWARMY_OUT db=$d"; done',
  ].join('\n');
}

/**
 * Copy-mode rename: only the three database-level statements mysqldump emits
 * per `--databases` entry (`DROP DATABASE`, `CREATE DATABASE`, `USE`). Views
 * that qualify columns with the source schema still point at it — a known
 * limit of an in-server copy.
 */
const SQL_RENAME_SED =
  "sed -e 's/^USE `\\([^`]*\\)`;/USE `\\1_'\"$SWARMY_SUFFIX\"'`;/' " +
  "-e 's/^\\(CREATE DATABASE [^`]*\\)`\\([^`]*\\)`/\\1`\\2_'\"$SWARMY_SUFFIX\"'`/' " +
  "-e 's/^\\(\\/\\*!40000 DROP DATABASE IF EXISTS \\)`\\([^`]*\\)`/\\1`\\2_'\"$SWARMY_SUFFIX\"'`/'";

function sqlLoad(wait: boolean): string[] {
  return [
    ...(wait ? SQL_WAIT : []),
    `[ -f ${D}/dump.sql ] || { echo "swarmy: the snapshot holds no dump.sql" >&2; exit 4; }`,
    'if [ "${SWARMY_MODE:-copy}" = copy ]; then',
    `  ${SQL_RENAME_SED} ${D}/dump.sql | my`,
    `  for d in $(cat ${D}/databases.txt 2>/dev/null); do echo "SWARMY_OUT db=\${d}_$SWARMY_SUFFIX"; done`,
    'else',
    `  my < ${D}/dump.sql`,
    `  for d in $(cat ${D}/databases.txt 2>/dev/null); do echo "SWARMY_OUT db=$d"; done`,
    'fi',
  ];
}

const SQL_SANITY = [
  `for d in $(cat ${D}/databases.txt 2>/dev/null); do`,
  '  my -e "USE \\`$d\\`" >/dev/null || { echo "swarmy: database $d is missing after the restore" >&2; exit 6; }',
  'done',
  "N=$(my -N -B -e \"SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA NOT IN ('mysql','sys','information_schema','performance_schema')\")",
  'echo "SWARMY_OUT objects=$N"',
];

const MONGO_PRELUDE = [
  'set -eu',
  'umask 077',
  'DUMP=$(command -v mongodump || true)',
  'RESTORE=$(command -v mongorestore || true)',
  'SH=$(command -v mongosh || command -v mongo || true)',
  'CFG=/dev/shm/swarmy-mongo.yaml',
  'LOG=/dev/shm/swarmy-mongo.log; [ -w /dev/shm ] || LOG=/tmp/swarmy-mongo.log',
  "trap 'rm -f \"$CFG\" \"$LOG\"' EXIT",
  'set -- --host=127.0.0.1 "--port=${SWARMY_DB_PORT:-27017}"',
  'if [ -n "${SWARMY_DB_USER:-}" ]; then',
  '  set -- "$@" "--username=$SWARMY_DB_USER" "--authenticationDatabase=${SWARMY_DB_AUTHDB:-admin}"',
  '  TOOL=${DUMP:-$RESTORE}',
  "  if [ -w /dev/shm ] && \"$TOOL\" --help 2>&1 | grep -q -- '--config'; then",
  "    printf \"password: '%s'\\n\" \"$(printf '%s' \"${SWARMY_DB_PASSWORD:-}\" | sed \"s/'/''/g\")\" > \"$CFG\"",
  '    set -- "$@" "--config=$CFG"',
  '  else',
  '    set -- "$@" "--password=${SWARMY_DB_PASSWORD:-}"',
  '  fi',
  'fi',
];

const MONGO_WAIT = [
  '[ -n "$SH" ] || { echo "swarmy: no mongosh/mongo shell in this image" >&2; exit 3; }',
  'i=0',
  "until \"$SH\" --quiet --host 127.0.0.1 --port \"${SWARMY_DB_PORT:-27017}\" --eval 'db.adminCommand({ping:1}).ok' 2>/dev/null | grep -q 1; do",
  '  i=$((i+1)); [ "$i" -ge 120 ] && { echo "swarmy: server never became ready" >&2; exit 5; }',
  '  sleep 2',
  'done',
];

const MONGO_DUMP = [
  ...MONGO_PRELUDE,
  '[ -n "$DUMP" ] || { echo "swarmy: no mongodump in this image" >&2; exit 3; }',
  '[ -z "${SWARMY_DB_NAME:-}" ] || set -- "$@" "--db=$SWARMY_DB_NAME"',
  `"$DUMP" "$@" --archive=${D}/dump.archive 2> "$LOG" || { cat "$LOG" >&2; exit 4; }`,
  'cat "$LOG" >&2',
  // mongodump logs `writing app.posts to archive …` (older) or "writing `app.posts` to …" (100.x).
  "sed -n 's/.*writing [`]\\{0,1\\}\\([^.`]*\\)\\..*/\\1/p' \"$LOG\" | grep -Ev '^(admin|config|local)$' | sort -u > " +
    `${D}/databases.txt || true`,
  'echo "SWARMY_OUT tool=mongodump"',
  `for d in $(cat ${D}/databases.txt); do echo "SWARMY_OUT db=$d"; done`,
].join('\n');

function mongoLoad(wait: boolean): string[] {
  return [
    '[ -n "$RESTORE" ] || { echo "swarmy: no mongorestore in this image" >&2; exit 3; }',
    ...(wait ? MONGO_WAIT : []),
    `[ -f ${D}/dump.archive ] || { echo "swarmy: the snapshot holds no dump.archive" >&2; exit 4; }`,
    `set -- "$@" --archive=${D}/dump.archive '--nsExclude=admin.*' '--nsExclude=config.*' '--nsExclude=local.*'`,
    'if [ "${SWARMY_MODE:-copy}" = copy ]; then',
    "  set -- \"$@\" '--nsFrom=$db$.$coll$' \"--nsTo=\\$db\\$_${SWARMY_SUFFIX}.\\$coll\\$\"",
    '  "$RESTORE" "$@"',
    `  for d in $(cat ${D}/databases.txt 2>/dev/null); do echo "SWARMY_OUT db=\${d}_$SWARMY_SUFFIX"; done`,
    'else',
    '  "$RESTORE" "$@" --drop',
    `  for d in $(cat ${D}/databases.txt 2>/dev/null); do echo "SWARMY_OUT db=$d"; done`,
    'fi',
  ];
}

/** Scratch-only: the throwaway root password is fine on argv (it dies with the container). */
const MONGO_SANITY = [
  'N=$("$SH" --quiet --host 127.0.0.1 --port "${SWARMY_DB_PORT:-27017}" -u "$SWARMY_DB_USER" -p "$SWARMY_DB_PASSWORD" --authenticationDatabase admin ' +
    "--eval 'var n=0; db.adminCommand({listDatabases:1}).databases.forEach(function(d){ if([\"admin\",\"config\",\"local\"].indexOf(d.name)<0){ n+=db.getSiblingDB(d.name).getCollectionNames().length; } }); print(n)' | tail -n 1)",
  'echo "SWARMY_OUT objects=$N"',
];

const KV_PRELUDE = [
  'set -eu',
  'CLI=$(command -v valkey-cli || command -v redis-cli || true)',
  '[ -n "$CLI" ] || { echo "swarmy: no redis-cli/valkey-cli in this image" >&2; exit 3; }',
  '[ -z "${SWARMY_DB_PASSWORD:-}" ] || export REDISCLI_AUTH="$SWARMY_DB_PASSWORD"',
  'r() { "$CLI" -h 127.0.0.1 -p "${SWARMY_DB_PORT:-6379}" "$@"; }',
];

const KV_DUMP = [
  ...KV_PRELUDE,
  'M=${SWARMY_DATA_MOUNT:?data mount}',
  'P=$(r PING 2>&1 || true)',
  'case "$P" in *PONG*) ;; *) echo "swarmy: the server refused PING ($P) — credentials?" >&2; exit 5;; esac',
  'dir=$(r CONFIG GET dir 2>/dev/null | sed -n 2p | tr -d \'\\r\' || true); [ -n "$dir" ] || dir=$M',
  'file=$(r CONFIG GET dbfilename 2>/dev/null | sed -n 2p | tr -d \'\\r\' || true); [ -n "$file" ] || file=dump.rdb',
  'aof=$(r CONFIG GET appendonly 2>/dev/null | sed -n 2p | tr -d \'\\r\' || true)',
  'case "$dir" in "$M"|"$M"/*) ;; *) echo "swarmy: the RDB dir $dir is not on the data volume ($M)" >&2; exit 6;; esac',
  'before=$(r LASTSAVE | tr -d \'\\r\')',
  'out=$(r BGSAVE 2>&1 || true)',
  'case "$out" in *"in progress"*|*started*|*scheduled*) ;; *) echo "swarmy: BGSAVE failed: $out" >&2; exit 7;; esac',
  'i=0',
  'while :; do',
  '  info=$(r INFO persistence | tr -d \'\\r\')',
  "  prog=$(printf '%s\\n' \"$info\" | sed -n 's/^rdb_bgsave_in_progress://p')",
  "  now=$(r LASTSAVE | tr -d '\\r')",
  '  if [ "$prog" = 0 ]; then',
  '    [ "$now" -gt "$before" ] && break',
  '    case "$out" in *scheduled*) ;; *) [ "$i" -ge 3 ] && break;; esac',
  '  fi',
  '  i=$((i+1)); [ "$i" -ge 900 ] && { echo "swarmy: BGSAVE did not finish in 15 minutes" >&2; exit 8; }',
  '  sleep 1',
  'done',
  "st=$(printf '%s\\n' \"$info\" | sed -n 's/^rdb_last_bgsave_status://p')",
  '[ "$st" = ok ] || { echo "swarmy: the last BGSAVE failed (rdb_last_bgsave_status=$st)" >&2; exit 7; }',
  `cp "$dir/$file" ${D}/dump.rdb`,
  'rel=${dir#"$M"}; rel=${rel#/}',
  'path=$file; [ -z "$rel" ] || path="$rel/$file"',
  `printf '%s\\n' "$path" > ${D}/rdbpath.txt`,
  `stat -c %u:%g "$dir" > ${D}/rdbowner.txt 2>/dev/null || true`,
  `: > ${D}/databases.txt`,
  'echo "SWARMY_OUT tool=$(basename "$CLI")"',
  'echo "SWARMY_OUT rdbpath=$path"',
  'echo "SWARMY_OUT appendonly=$aof"',
].join('\n');

/**
 * Redis/Valkey file placement — runs in a plain-shell sidecar (the restic
 * image), the target volume at `/target`. In-place keeps the replaced RDB
 * beside it (`.swarmy-pre-restore-<suffix>`) on top of the safety dump.
 */
export const KV_PLACE_SCRIPT = [
  'set -eu',
  `P=$(cat ${D}/rdbpath.txt 2>/dev/null || echo dump.rdb)`,
  'case "$P" in /*|*..*) echo "swarmy: bad RDB path $P" >&2; exit 4;; esac',
  `[ -f ${D}/dump.rdb ] || { echo "swarmy: the snapshot holds no dump.rdb" >&2; exit 4; }`,
  'T="/target/$P"',
  'mkdir -p "$(dirname "$T")"',
  '[ ! -f "$T" ] || mv "$T" "$T.swarmy-pre-restore-${SWARMY_SUFFIX:-x}"',
  `cp ${D}/dump.rdb "$T"`,
  `O=$(cat ${D}/rdbowner.txt 2>/dev/null || true)`,
  '[ -z "$O" ] || chown "$O" "$T" "$(dirname "$T")" || true',
  'echo "SWARMY_OUT rdbpath=$P"',
].join('\n');

const KV_SANITY = [
  ...KV_PRELUDE,
  'CHK=$(command -v valkey-check-rdb || command -v redis-check-rdb || true)',
  `[ -z "$CHK" ] || "$CHK" ${D}/dump.rdb >&2 || { echo "swarmy: the RDB failed its integrity check" >&2; exit 6; }`,
  'i=0',
  'until r PING 2>/dev/null | grep -q PONG && r INFO persistence 2>/dev/null | tr -d \'\\r\' | grep -q \'^loading:0\'; do',
  '  i=$((i+1)); [ "$i" -ge 120 ] && { echo "swarmy: server never became ready" >&2; exit 5; }',
  '  sleep 1',
  'done',
  "N=$(r INFO keyspace | tr -d '\\r' | sed -n 's/^db[0-9]*:keys=\\([0-9]*\\).*/\\1/p' | awk '{s+=$1} END {print s+0}')",
  'echo "SWARMY_OUT objects=$N"',
].join('\n');

// ── postgres (compose; one custom-format pg_dump per database) ──────────────

/** libpq reads these; PGPASSWORD is container env like every other credential here. */
const PG_PRELUDE = [
  'set -eu',
  'command -v pg_dump >/dev/null 2>&1 || { echo "swarmy: no pg_dump in this image" >&2; exit 3; }',
  'export PGHOST=127.0.0.1 PGPORT="${SWARMY_DB_PORT:-5432}" PGUSER="${SWARMY_DB_USER:-postgres}" PGPASSWORD="${SWARMY_DB_PASSWORD:-}"',
  // Connect to the app database in user scope (the user may not reach `postgres`).
  'export PGDATABASE="${SWARMY_DB_NAME:-postgres}"',
];

const PG_WAIT = [
  'i=0',
  "until psql -Atqc 'SELECT 1' >/dev/null 2>&1; do",
  '  i=$((i+1)); [ "$i" -ge 120 ] && { echo "swarmy: server never became ready" >&2; psql -Atqc \'SELECT 1\' >&2 || true; exit 5; }',
  '  sleep 2',
  'done',
];

const PG_DUMP = [
  ...PG_PRELUDE,
  'if [ -n "${SWARMY_DB_NAME:-}" ]; then DBS="$SWARMY_DB_NAME"; else',
  "  DBS=$(psql -Atqc \"SELECT datname FROM pg_database WHERE NOT datistemplate AND datallowconn ORDER BY 1\")",
  'fi',
  `: > ${D}/databases.txt`,
  'for d in $DBS; do',
  `  pg_dump -Fc -d "$d" -f "${D}/db-$d.pgc"`,
  `  echo "$d" >> ${D}/databases.txt`,
  '  echo "SWARMY_OUT db=$d"',
  'done',
  'echo "SWARMY_OUT tool=pg_dump"',
].join('\n');

/**
 * Copy: `CREATE DATABASE <db>_<suffix>` + `pg_restore --no-owner`. In place:
 * `pg_restore --clean --if-exists` into the live database (created if missing)
 * — objects the dump doesn't know about are left alone.
 */
function pgLoad(wait: boolean): string[] {
  return [
    ...(wait ? PG_WAIT : []),
    `[ -s ${D}/databases.txt ] || { echo "swarmy: the snapshot lists no databases" >&2; exit 4; }`,
    `for d in $(cat ${D}/databases.txt); do`,
    '  if [ "${SWARMY_MODE:-copy}" = copy ]; then n="${d}_$SWARMY_SUFFIX"; else n="$d"; fi',
    "  if ! psql -Atqc \"SELECT 1 FROM pg_database WHERE datname = '$n'\" | grep -q 1; then",
    '    psql -qc "CREATE DATABASE \\"$n\\""',
    '  fi',
    '  if [ "${SWARMY_MODE:-copy}" = copy ]; then',
    `    pg_restore --no-owner --no-acl -d "$n" "${D}/db-$d.pgc"`,
    '  else',
    `    pg_restore --clean --if-exists --no-owner -d "$n" "${D}/db-$d.pgc"`,
    '  fi',
    '  echo "SWARMY_OUT db=$n"',
    'done',
  ];
}

const PG_SANITY = [
  'N=0',
  `for d in $(cat ${D}/databases.txt); do`,
  "  c=$(psql -Atq -d \"$d\" -c \"SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')\")",
  '  N=$((N + c))',
  'done',
  'echo "SWARMY_OUT objects=$N"',
];

/** The dump sidecar's script (task image, task netns, scratch at {@link APPDB_DUMP_MOUNT}). */
export function dumpScript(engine: AppDbEngine, scope: AppDbCreds['scope']): string {
  if (isSqlEngine(engine)) return sqlDump(scope);
  if (engine === 'postgres') return PG_DUMP;
  if (engine === 'mongo') return MONGO_DUMP;
  return KV_DUMP;
}

/** The load sidecar's script for SQL/Mongo restores into the running server. */
export function loadScript(engine: 'mysql' | 'mariadb' | 'postgres' | 'mongo'): string {
  if (isSqlEngine(engine)) return [...SQL_PRELUDE, ...sqlLoad(false)].join('\n');
  if (engine === 'postgres') return [...PG_PRELUDE, ...pgLoad(false)].join('\n');
  return [...MONGO_PRELUDE, ...mongoLoad(false)].join('\n');
}

/** Drill: wait for the scratch server, load in place, run the sanity query. */
export function verifyScript(engine: AppDbEngine): string {
  if (isSqlEngine(engine)) return [...SQL_PRELUDE, ...sqlLoad(true), ...SQL_SANITY].join('\n');
  if (engine === 'postgres') return [...PG_PRELUDE, ...pgLoad(true), ...PG_SANITY].join('\n');
  if (engine === 'mongo') return [...MONGO_PRELUDE, ...mongoLoad(true), ...MONGO_SANITY].join('\n');
  return KV_SANITY;
}

/**
 * Env for the scratch server the drill starts (official + bitnami names) and
 * the credentials the verify sidecar then uses. `password` is minted on the
 * node and dies with the container.
 */
export function scratchServerEnv(engine: AppDbEngine, password: string): {
  server: string[];
  client: string[];
} {
  if (isSqlEngine(engine)) {
    return {
      server: [`MYSQL_ROOT_PASSWORD=${password}`, `MARIADB_ROOT_PASSWORD=${password}`],
      client: ['SWARMY_DB_USER=root', `SWARMY_DB_PASSWORD=${password}`, 'SWARMY_DB_PORT=3306', 'SWARMY_MODE=in-place'],
    };
  }
  if (engine === 'postgres') {
    return {
      server: [`POSTGRES_PASSWORD=${password}`, `POSTGRESQL_PASSWORD=${password}`, `POSTGRESQL_POSTGRES_PASSWORD=${password}`],
      client: ['SWARMY_DB_USER=postgres', `SWARMY_DB_PASSWORD=${password}`, 'SWARMY_DB_PORT=5432', 'SWARMY_MODE=in-place'],
    };
  }
  if (engine === 'mongo') {
    return {
      server: [
        'MONGO_INITDB_ROOT_USERNAME=root',
        `MONGO_INITDB_ROOT_PASSWORD=${password}`,
        'MONGODB_ROOT_USER=root',
        `MONGODB_ROOT_PASSWORD=${password}`,
      ],
      client: [
        'SWARMY_DB_USER=root',
        `SWARMY_DB_PASSWORD=${password}`,
        'SWARMY_DB_AUTHDB=admin',
        'SWARMY_DB_PORT=27017',
        'SWARMY_MODE=in-place',
      ],
    };
  }
  return {
    server: ['ALLOW_EMPTY_PASSWORD=yes', 'REDIS_AOF_ENABLED=no', 'VALKEY_AOF_ENABLED=no'],
    client: ['SWARMY_DB_PORT=6379'],
  };
}

/** `copy_YYYYMMDDHHmm` (UTC) — the restore-as-a-copy suffix. */
export function copySuffix(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `copy_${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}${p(now.getUTCHours())}${p(now.getUTCMinutes())}`;
}

/** restic tags for an app DB's snapshots (`reason:*` is excluded from retention scope). */
export function appDbTags(
  orgId: string,
  stack: string,
  service: string,
  engine: AppDbEngine,
  reason: 'scheduled' | 'manual' | 'pre-restore',
): string[] {
  return [`org:${orgId}`, `appdb:${stack}/${service}`, `engine:${engine}`, `reason:${reason}`];
}

/** The tags `restic forget` is scoped to (AND-joined agent-side). */
export function appDbRetentionTags(tags: string[]): string[] {
  return tags.filter((t) => !t.startsWith('reason:'));
}

/** restic `--host` for an app DB (stable across nights → dedup + retention grouping). */
export function appDbHost(stack: string, service: string): string {
  return `${APPDB_HOST_PREFIX}-${service || stack}`;
}
