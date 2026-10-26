/**
 * What `db.pooler` returns (the Postgres page's pooler section) and the
 * parser for the live numbers it shows. PURE; the dashboard reads the type
 * from here, never a redeclaration.
 */
import { POOLER_AUTH_USER } from './manageddb-pooler-boot';
import type { DbConnectVia, PoolerConfig } from './manageddb-pooler';

/** PgBouncer's `SHOW POOLS`, summed over the app pools (the admin and auth pools left out). */
export interface PoolerTraffic {
  /** Clients with a server connection now. */
  clientsActive: number;
  /** Clients queued for one (the pool is full). */
  clientsWaiting: number;
  serversActive: number;
  serversIdle: number;
  /** Database × user pools open. */
  pools: number;
}

export interface DbPoolerView {
  stack: string;
  cluster: string;
  /** The declaration (`swarmy.db.pooler` on the primary); null = off. */
  declared: PoolerConfig | null;
  service: string;
  /** `host:port` on the cluster's private network. */
  address: string;
  status: 'running' | 'degraded' | 'deploying' | 'failing' | 'idle' | 'stopped' | 'absent';
  running: number;
  desired: number;
  /** The writer it points at now (its label), and the writer it should point at. */
  target: string | null;
  writer: string | null;
  /** The reconcile has a change to make (create, update, repoint or remove). */
  converging: boolean;
  /** Live from the pooler's admin console; null when it can't be read now. */
  traffic: PoolerTraffic | null;
  /** Every app wired to the cluster, with the variable it reads and the path it takes. */
  apps: Array<{ service: string; envVar: string; via: DbConnectVia }>;
}

const NUM = ['cl_active', 'cl_waiting', 'sv_active', 'sv_idle'] as const;

/** `psql -A -F '|'` output of `SHOW POOLS` (header first) → the totals; null when unreadable. */
export function parseShowPools(output: string): PoolerTraffic | null {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const header = lines[0]?.split('|');
  if (!header) return null;
  const col = (name: string) => header.indexOf(name);
  if ([...NUM, 'database', 'user'].some((n) => col(n) < 0)) return null;
  const out: PoolerTraffic = { clientsActive: 0, clientsWaiting: 0, serversActive: 0, serversIdle: 0, pools: 0 };
  for (const line of lines.slice(1)) {
    const f = line.split('|');
    if (f.length !== header.length || f[col('database')] === 'pgbouncer' || f[col('user')] === POOLER_AUTH_USER) continue;
    const n = (k: (typeof NUM)[number]) => Number.parseInt(f[col(k)] ?? '', 10) || 0;
    out.clientsActive += n('cl_active');
    out.clientsWaiting += n('cl_waiting');
    out.serversActive += n('sv_active');
    out.serversIdle += n('sv_idle');
    out.pools += 1;
  }
  return out;
}
