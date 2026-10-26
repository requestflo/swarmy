/**
 * What a whole-app restore covers: the app's saved volumes and its managed
 * Postgres clusters, the services stopped for it, and what is left alone.
 *
 * - Managed Postgres keeps running: a logical restore loads into the live
 *   server and a PITR stops and starts its own primary. Its data volumes are
 *   restored as the database, never as files under a running server.
 * - Other managed stores (cache, search, vector) keep running and are not
 *   touched; their volumes are left out.
 * - A global service runs on every server and can't be paused, so it keeps
 *   running and any volume it mounts is left out.
 * - Everything else of the app with copies running is stopped once.
 */
import { DB_DATA_VOLUME_LABEL, STACK_LABEL, buildInventory, type AppRestoreLeftOutWhy, type AppRestoreScopeView } from '@swarmy/core';
import type { OrgContext } from '../context';
import { DB_CLUSTER_LABEL, DB_MEMBER_LABEL, DB_ROLE_LABEL } from './manageddb.service';
import { listStacks } from './stack.service';

const MANAGED_PREFIXES = ['swarmy.cache.', 'swarmy.search.', 'swarmy.vector.'];

/** The few facts the scope needs about a live service. */
export interface ScopeService {
  name: string;
  stack: string;
  mode: 'replicated' | 'global';
  desired: number;
  labels: Record<string, string>;
  /** Named volumes it mounts. */
  volumes: string[];
}

function role(s: ScopeService): AppRestoreLeftOutWhy | null {
  if (s.labels[DB_CLUSTER_LABEL]) return 'database';
  if (Object.keys(s.labels).some((k) => MANAGED_PREFIXES.some((p) => k.startsWith(p)))) return 'managed';
  return s.mode === 'global' ? 'global' : null;
}

/** PURE: the scope of `stack` over the org's live services and the volumes its catalogue has saves of. */
export function appRestoreScopeOf(stack: string, services: ScopeService[], savedVolumes: string[]): AppRestoreScopeView {
  const mine = services.filter((s) => s.stack === stack);
  const databases = [
    ...new Set(mine.filter((s) => s.labels[DB_ROLE_LABEL] === 'primary' && !s.labels[DB_MEMBER_LABEL]).map((s) => s.labels[DB_CLUSTER_LABEL]!).filter(Boolean)),
  ].sort();
  const held = new Map<string, AppRestoreLeftOutWhy>();
  for (const s of mine) {
    const why = role(s);
    if (!why) continue;
    for (const v of [...s.volumes, s.labels[DB_DATA_VOLUME_LABEL] ?? '']) if (v && !held.has(v)) held.set(v, why);
  }
  // A Postgres volume no member mounts right now still belongs to the database (`<stack>_<cluster>-…-data`).
  const pgVolume = (v: string): boolean => databases.some((c) => v.startsWith(`${stack}_${c}-`) && v.endsWith('-data'));
  const leftOut: AppRestoreScopeView['leftOut'] = [];
  const volumes: string[] = [];
  for (const v of [...new Set(savedVolumes)].sort()) {
    const why = held.get(v) ?? (pgVolume(v) ? 'database' : null);
    if (why) leftOut.push({ volume: v, why });
    else volumes.push(v);
  }
  const stops: AppRestoreScopeView['stops'] = [];
  const keepsRunning: AppRestoreScopeView['keepsRunning'] = [];
  for (const s of [...mine].sort((a, b) => a.name.localeCompare(b.name))) {
    const why = role(s);
    if (why) keepsRunning.push({ service: s.name, why });
    else if (s.desired > 0) stops.push({ service: s.name, replicas: s.desired });
  }
  return { stack, volumes, leftOut, databases, stops, keepsRunning };
}

/** The org's live services as {@link ScopeService}s (inventory's stack attribution, the spec's named mounts). */
export function scopeServices(ctx: Pick<OrgContext, 'hub' | 'activeOrgId'>): ScopeService[] {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  const stackOf = new Map(buildInventory(services, containers).services.map((s) => [s.name, s.stack]));
  return services.map((s) => ({
    name: s.name,
    stack: stackOf.get(s.name) ?? s.labels[STACK_LABEL] ?? '',
    mode: s.mode,
    desired: s.mode === 'replicated' ? (s.desiredReplicas ?? 0) : 0,
    labels: s.labels,
    volumes: (s.mounts ?? []).filter((m) => m.source && (!m.type || m.type === 'volume')).map((m) => m.source!),
  }));
}

/**
 * Volumes of `stack` with any save in the catalogue. Attributed like
 * `listSnapshots`: to the LONGEST live stack whose `<stack>_` prefix matches,
 * so `shop` never claims `shop_x`'s volumes.
 */
export async function savedVolumesOf(ctx: OrgContext, stack: string): Promise<string[]> {
  const rows = await ctx.db.snapshot.findMany({
    where: { orgId: ctx.activeOrgId, volume: { startsWith: `${stack}_` } },
    select: { volume: true },
    distinct: ['volume'],
  });
  const stacks = (await listStacks(ctx)).map((s) => s.name);
  return rows
    .map((r) => r.volume)
    .filter((v) => (stacks.filter((n) => v.startsWith(`${n}_`)).sort((a, b) => b.length - a.length)[0] ?? stack) === stack);
}

/** `backups.appRestoreScope`. */
export async function appRestoreScope(ctx: OrgContext, stack: string): Promise<AppRestoreScopeView> {
  return appRestoreScopeOf(stack, scopeServices(ctx), await savedVolumesOf(ctx, stack));
}
