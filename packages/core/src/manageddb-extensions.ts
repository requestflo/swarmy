/**
 * Managed Postgres extensions beyond pgvector (board 39): the label scheme,
 * the catalog, and the SQL the reconcile runs. The rolling-restart planner is
 * `manageddb-extensions-plan.ts`; the boot layer that turns the preload into
 * `shared_preload_libraries` is `manageddb-pg.ts` (`SWARMY_PG_PRELOAD`).
 *
 * Declared on the cluster's primary (written by `db.setExtension`):
 *   swarmy.db.extensions            the wanted set, sorted CSV
 * Stamped by the manageddb reconcile:
 *   swarmy.db.extensions.applied    what CREATE EXTENSION made true on the primary
 *   swarmy.db.extensions.available  catalog names the image ships (pg_available_extensions)
 *   swarmy.db.extensions.probed     the image that probe ran against
 *   swarmy.db.extensions.error      `<wanted>|<message>`: a CREATE that failed; not
 *                                   retried until the wanted set changes
 *   swarmy.db.restart.planned       ISO time of a planned writer restart; the failover
 *                                   logic stands down while it is fresh
 * Member env (the boot layer's own Docker truth):
 *   SWARMY_PG_PRELOAD               the shared_preload_libraries written on every start
 *
 * pgvector keeps its own enable-in-place path (`swarmy.vector.pgvector`).
 */
import { PG_ENV, PG_PASSWORD_FROM_MEMBER } from './manageddb-pg';

export const DB_EXTENSIONS_LABEL = 'swarmy.db.extensions';
export const DB_EXTENSIONS_APPLIED_LABEL = 'swarmy.db.extensions.applied';
export const DB_EXTENSIONS_AVAILABLE_LABEL = 'swarmy.db.extensions.available';
export const DB_EXTENSIONS_PROBED_LABEL = 'swarmy.db.extensions.probed';
export const DB_EXTENSIONS_ERROR_LABEL = 'swarmy.db.extensions.error';
export const DB_RESTART_PLANNED_LABEL = 'swarmy.db.restart.planned';
/** Env the boot layer turns into `shared_preload_libraries`. */
export const PG_PRELOAD_ENV = PG_ENV.preload;
/** How long a planned writer restart holds the failover alarm (then it is a real outage). */
export const DB_RESTART_PLANNED_MAX_AGE_MS = 3 * 60_000;

/**
 * The extensions swarmy toggles. `preload` = the library the server must load
 * at start (a restart of every copy); `canDisable` = false when DROP EXTENSION
 * would drop user columns (postgis geometry, like pgvector's vectors).
 */
export const PG_EXTENSION_CATALOG = {
  pg_stat_statements: { preload: 'pg_stat_statements', canDisable: true, contrib: true },
  postgis: { preload: null, canDisable: false, contrib: false },
} as const;

export type PgExtensionName = keyof typeof PG_EXTENSION_CATALOG;
export const PG_EXTENSION_NAMES = Object.keys(PG_EXTENSION_CATALOG).sort() as PgExtensionName[];

export function isPgExtensionName(s: string): s is PgExtensionName {
  return Object.prototype.hasOwnProperty.call(PG_EXTENSION_CATALOG, s);
}

/** CSV label → catalog names, sorted and unique (anything else is ignored). */
export function parseExtList(raw: string | undefined): PgExtensionName[] {
  const names = (raw ?? '').split(',').map((s) => s.trim()).filter(isPgExtensionName);
  return [...new Set(names)].sort();
}

export function encodeExtList(list: readonly PgExtensionName[]): string {
  return [...new Set(list)].sort().join(',');
}

/** A comma list, trimmed + sorted, so `SHOW` output compares to the spec env. */
export function normalizePreload(s: string | undefined): string {
  return (s ?? '').split(',').map((x) => x.trim().replace(/^"|"$/g, '')).filter(Boolean).sort().join(',');
}

/** The `shared_preload_libraries` a wanted set needs. */
export function preloadOf(list: readonly PgExtensionName[]): string {
  return normalizePreload(list.map((n) => PG_EXTENSION_CATALOG[n].preload ?? '').join(','));
}

/** A member spec's preload (its env). */
export function envPreload(env: Record<string, string>): string {
  return normalizePreload(env[PG_PRELOAD_ENV]);
}

/** Set (or drop, when empty) the preload on a member env. */
export function withPreloadEnv(env: Record<string, string>, preload: string): Record<string, string> {
  const out = { ...env };
  if (preload) out[PG_PRELOAD_ENV] = preload;
  else delete out[PG_PRELOAD_ENV];
  return out;
}

/** The preload env a FRESH member spec gets from the primary's declared extensions. */
export function pgPreloadEnv(labels: Record<string, string> | undefined): Record<string, string> {
  const preload = preloadOf(parseExtList(labels?.[DB_EXTENSIONS_LABEL]));
  return preload ? { [PG_PRELOAD_ENV]: preload } : {};
}

/** Is a planned writer restart (fresh) under way on this primary? */
export function plannedRestartActive(labels: Record<string, string> | undefined, now: number): boolean {
  const at = Date.parse(labels?.[DB_RESTART_PLANNED_LABEL] ?? '');
  return Number.isFinite(at) && now - at >= 0 && now - at <= DB_RESTART_PLANNED_MAX_AGE_MS;
}

/** `<wanted>|<message>` → the wanted set it failed for + why. */
export function parseExtError(raw: string | undefined): { wanted: string; message: string } | null {
  if (!raw) return null;
  const i = raw.indexOf('|');
  return i < 0 ? { wanted: '', message: raw } : { wanted: raw.slice(0, i), message: raw.slice(i + 1) };
}

/** Which catalog extensions the image ships (one row: a CSV). */
export const PG_EXTENSIONS_PROBE_SQL =
  `SELECT coalesce(string_agg(name, ',' ORDER BY name), '') FROM pg_available_extensions WHERE name IN (${PG_EXTENSION_NAMES.map((n) => `'${n}'`).join(', ')})`;
/** What the running server actually loaded. */
export const PG_PRELOAD_SQL = 'SHOW shared_preload_libraries';

/** CREATE / DROP for a catalog name (never CASCADE: a DROP that would take user objects fails). */
export function extensionSql(name: PgExtensionName, on: boolean): string {
  return on ? `CREATE EXTENSION IF NOT EXISTS ${name}` : `DROP EXTENSION IF EXISTS ${name}`;
}

/**
 * `sh -c` for one statement inside a member, as the superuser, in the app
 * database (POSTGRES_DB; a promoted standby without it falls back to
 * `postgres`). The password comes from the member's own secret file.
 */
export function pgMemberSqlScript(sql: string): string {
  return `${PG_PASSWORD_FROM_MEMBER} psql -U postgres -d "\${POSTGRES_DB:-postgres}" -v ON_ERROR_STOP=1 -tAc "${sql}"`;
}
