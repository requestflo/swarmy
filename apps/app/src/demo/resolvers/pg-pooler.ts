import { isPoolSize, poolerAddress, poolerServiceName, type DbPoolerView, type PoolerConfig } from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';
import { stackLinks } from './stack-links';

/**
 * Demo `db.pooler` / `db.setPooler` / `db.detach`, and `db.inject` with
 * `via` (Postgres page, board 39). Wraps stack-links' `db.inject` (so it
 * comes after it in the registry) and reads its wired apps. A change walks
 * the reconcile's pace on a clock: the pooler is "starting" for ~4 s. Seeded:
 * storefront/checkout pools in transaction mode with storefront_api through
 * it; data/main has none.
 */

interface PoolerState {
  decl: Record<string, (PoolerConfig & { at: number }) | undefined>;
  /** `stack/cluster` → app service → 'pooler'. */
  via: Record<string, Record<string, 'pooler'>>;
}

const STEP_MS = 4_000;
const LINKS = stackLinks.handlers!;

function state(s: DemoStore): PoolerState {
  s.extra.pgPooler ??= {
    decl: { 'storefront/checkout': { mode: 'transaction', poolSize: 20, at: 0 } },
    via: { 'storefront/checkout': { storefront_api: 'pooler' } },
  } satisfies PoolerState;
  return s.extra.pgPooler as PoolerState;
}

function wired(s: DemoStore, stack: string, cluster: string): string[] {
  if (!s.extra.stackLinks) LINKS['stacks.endpoints']!({ stack }, s);
  return ((s.extra.stackLinks as { dbAttached?: Record<string, string[]> } | undefined)?.dbAttached ?? {})[`${stack}/${cluster}`] ?? [];
}

function view(s: DemoStore, stack: string, cluster: string): DbPoolerView {
  const key = `${stack}/${cluster}`;
  const d = state(s).decl[key];
  const via = state(s).via[key] ?? {};
  const starting = !!d && Date.now() - d.at < STEP_MS;
  const writer = `${stack}_${cluster}-primary`;
  const apps = wired(s, stack, cluster).map((service) => ({ service, envVar: 'DATABASE_URL', via: via[service] ?? ('direct' as const) }));
  const through = apps.filter((a) => a.via === 'pooler').length;
  return {
    stack,
    cluster,
    declared: d ? { mode: d.mode, poolSize: d.poolSize } : null,
    service: poolerServiceName(stack, cluster),
    address: poolerAddress(stack, cluster),
    status: d && !starting ? 'running' : 'absent',
    running: d && !starting ? 1 : 0,
    desired: d && !starting ? 1 : 0,
    target: d && !starting ? writer : null,
    writer,
    converging: starting,
    traffic: d && !starting ? { clientsActive: 9 * through + 3, clientsWaiting: 0, serversActive: Math.min(d.poolSize, 4), serversIdle: Math.min(d.poolSize, 6), pools: 1 } : null,
    apps,
  };
}

const ref = (i: unknown) => i as { stack: string; cluster: string };

export const pgPoolerDemo: DomainResolvers = {
  handlers: {
    'db.pooler': (i, s) => view(s, ref(i).stack, ref(i).cluster),
    'db.setPooler': (i, s) => {
      const { stack, cluster, enabled, mode, poolSize } = i as { stack: string; cluster: string; enabled: boolean; mode?: 'transaction' | 'session'; poolSize?: number };
      const key = `${stack}/${cluster}`;
      const st = state(s);
      const cur = st.decl[key];
      const next = enabled ? { mode: mode ?? cur?.mode ?? 'transaction', poolSize: poolSize ?? cur?.poolSize ?? 20 } : null;
      if (next && !isPoolSize(next.poolSize)) throw new Error('the pool size must be a whole number between 1 and 80');
      const service = poolerServiceName(stack, cluster);
      const same = (!cur && !next) || (cur && next && cur.mode === next.mode && cur.poolSize === next.poolSize);
      if (same) return { stack, cluster, pooler: next, changed: false, service };
      const through = Object.keys(st.via[key] ?? {});
      if (!next && through.length) throw new Error(`${through.join(', ')} connects through the pooler: connect it directly first`);
      st.decl[key] = next ? { ...next, at: Date.now() } : undefined;
      return { stack, cluster, pooler: next, changed: true, service };
    },
    'db.inject': (i, s) => {
      const { stack, cluster, appService, via = 'direct' } = i as { stack: string; cluster: string; appService: string; via?: 'direct' | 'pooler' };
      const key = `${stack}/${cluster}`;
      const st = state(s);
      if (via === 'pooler' && !st.decl[key]) throw new Error(`${cluster} has no pooler: turn it on first, then connect ${appService} through it`);
      const r = LINKS['db.inject']!(i, s) as { rwUrl: string };
      const map = (st.via[key] ??= {});
      if (via === 'pooler') map[appService] = 'pooler';
      else delete map[appService];
      return { ...r, via, ...(via === 'pooler' ? { rwUrl: `postgres://postgres:****@${poolerAddress(stack, cluster)}/app` } : {}) };
    },
    'db.detach': (i, s) => {
      const { stack, cluster, appService } = i as { stack: string; cluster: string; appService: string };
      const key = `${stack}/${cluster}`;
      const links = s.extra.stackLinks as { dbAttached: Record<string, string[]> };
      if (!wired(s, stack, cluster).includes(appService)) throw new Error(`${appService} is not connected to ${cluster}`);
      links.dbAttached[key] = links.dbAttached[key]!.filter((a) => a !== appService);
      const via = state(s).via[key]?.[appService] ?? 'direct';
      delete state(s).via[key]?.[appService];
      return { appService, cluster, envVar: 'DATABASE_URL', via, detached: true };
    },
  },
};
