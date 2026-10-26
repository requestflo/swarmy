/**
 * A managed Postgres cluster's connection pooler (board 39, "PgBouncer"): an
 * optional PgBouncer service in front of the writer, so many app connections
 * share a few server connections. PURE.
 *
 * Declared on the primary (written by `db.setPooler`); absent = off, the
 * default:
 *   swarmy.db.pooler   {"mode":"transaction"|"session","poolSize":<n>}
 *
 * The manageddb reconcile converges a `<stack>_<cluster>-pooler` service on
 * the cluster's overlay to it, pointed at the current writer
 * (manageddb-pooler-spec.ts, manageddb-pooler-plan.ts). Apps reach it as
 * `<stack>_<cluster>-pooler:6432` when wired "through the pooler".
 *
 * The modes, as PgBouncer runs them:
 *   transaction  a server connection is lent for one transaction, then
 *                returned: the most sharing, but anything that lives on a
 *                session (SQL PREPARE, LISTEN/NOTIFY, advisory locks, SET,
 *                temporary tables) does not survive between transactions.
 *   session      a server connection is held for the client's whole session:
 *                every Postgres feature works, with less sharing.
 */

export const DB_POOLER_LABEL = 'swarmy.db.pooler';

export const POOLER_MODES = ['transaction', 'session'] as const;
export type PoolerMode = (typeof POOLER_MODES)[number];

export interface PoolerConfig {
  mode: PoolerMode;
  /** Server connections per database the pooler keeps to the writer (`default_pool_size`). */
  poolSize: number;
}

/** PgBouncer's own defaults: transaction pooling, 20 server connections per database. */
export const POOLER_DEFAULT: PoolerConfig = { mode: 'transaction', poolSize: 20 };
export const POOLER_POOL_MIN = 1;
/**
 * Upper bound swarmy offers: the official image allows 100 connections, and
 * direct apps, the studio, backups and superuser slots need some of them.
 */
export const POOLER_POOL_MAX = 80;
/** The pooler's port on the cluster network (PgBouncer's conventional port). */
export const POOLER_PORT = 6432;

export function isPoolerMode(v: unknown): v is PoolerMode {
  return typeof v === 'string' && (POOLER_MODES as readonly string[]).includes(v);
}

export function isPoolSize(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= POOLER_POOL_MIN && n <= POOLER_POOL_MAX;
}

/** The label value → its declaration, or null (absent, or not one swarmy would write). */
export function parsePoolerConfig(raw: string | undefined): PoolerConfig | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { mode?: unknown; poolSize?: unknown } | null;
    if (!v || typeof v !== 'object' || !isPoolerMode(v.mode) || !isPoolSize(v.poolSize)) return null;
    return { mode: v.mode, poolSize: v.poolSize };
  } catch {
    return null;
  }
}

/** The label value, keys in a fixed order (so equal declarations are equal strings). */
export function encodePoolerConfig(c: PoolerConfig): string {
  return JSON.stringify({ mode: c.mode, poolSize: c.poolSize });
}

export function samePoolerConfig(a: PoolerConfig | null, b: PoolerConfig | null): boolean {
  return a === b || (a !== null && b !== null && a.mode === b.mode && a.poolSize === b.poolSize);
}

/** `<stack>_<cluster>-pooler`: the service, and its swarm DNS name on the cluster network. */
export function poolerServiceName(stack: string, cluster: string): string {
  return `${stack}_${cluster}-pooler`;
}
