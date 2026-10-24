import type { CacheClusterView, CacheTopology, NodeSummary } from '@swarmy/core';
import type { Tone } from '@/components/calm';
import type { FlowBox, FlowLink } from '@/components/stack-data/flow-diagram';
import { serverList } from '@/components/stack-data/use-member-servers';

/**
 * A cache in plain words (board 41, DataStores): its shape as boxes and
 * lines and "If <server> dies: …" from its members and the servers they run
 * on. Its when-full + persistence words are in cache-policy-words. PURE —
 * tested in cache-words.test.ts.
 */

/** `cache.list` carries the purpose (`swarmy.cache.purpose`) beside the core view. */
export type CacheView = CacheClusterView & { purpose?: 'cache' | 'queue' };
export type Placement = Map<string, NodeSummary[]> | undefined;

export const TOPO_WORDS: Record<CacheTopology, { label: string; hint: string }> = {
  single: { label: 'Single', hint: 'one copy' },
  replica: { label: 'Standby copy', hint: 'a copy, no switch-over' },
  sentinel: { label: 'Sentinel', hint: 'switches over by vote' },
};

const short = (svc: string): string => svc.replace(/^[^_]*_/, '');
const andList = (xs: string[]): string => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : (xs[0] ?? ''));

function serversOf(v: CacheView, place: Placement, role: 'primary' | 'replica' | 'sentinel'): NodeSummary[] {
  const all = v.members.filter((m) => m.role === role).flatMap((m) => place?.get(m.service) ?? []);
  return all.filter((n, i) => all.findIndex((x) => x.id === n.id) === i);
}

export function cacheTone(v: CacheView): Tone {
  const s = v.primary.status;
  if (s === 'absent' || s === 'stopped' || s === 'failing') return 'bad';
  if (s === 'deploying') return 'info';
  return s === 'running' && v.replicas.running >= v.replicas.desired ? 'ok' : 'warn';
}

export function envVarOf(v: CacheView): string {
  return v.attachments[0]?.envVar ?? (v.purpose === 'queue' ? 'QUEUE_URL' : 'REDIS_URL');
}

/** "If wkr-2 dies: …" — what happens to the apps when the primary's server goes. */
export function ifDies(v: CacheView, place: Placement): { server: string; text: string; tone: Tone; tech: string } {
  const main = serversOf(v, place, 'primary')[0];
  const server = main?.name ?? 'its server';
  const apps = v.attachments.map((a) => short(a.service));
  const who = apps.length ? andList(apps) : 'apps using it';
  const standbys = serversOf(v, place, 'replica').filter((n) => n.id !== main?.id);
  const standby = serverList(standbys);
  const copies = v.replicas.running > 1 ? 'standby copies' : 'standby copy';
  const env = envVarOf(v);
  if (v.topology === 'single' || v.replicas.running === 0) {
    const none = v.topology === 'single' ? '' : 'No standby copy is running, so ';
    return {
      server,
      tone: 'warn',
      text: `${none}${who} lose the cache until ${server} is back. It stays on ${server}, because its data lives on that server’s disk.`,
      tech: `primary pinned (swarmy.cache.node) · data on ${v.stack}_${v.name}-cache-data`,
    };
  }
  if (v.topology === 'replica' || !standby) {
    return {
      server,
      tone: 'warn',
      text: `${standby ? `The ${copies} on ${standby} ${v.replicas.running > 1 ? 'keep' : 'keeps'} the data, but nothing switches over by itself` : 'No standby copy is on another server'}, so ${who} can’t reach the cache until ${server} is back.`,
      tech: `${v.topology === 'replica' ? 'replica topology: no sentinels · ' : ''}${env} names ${v.host}`,
    };
  }
  const need = Math.floor(v.sentinels.desired / 2) + 1;
  if (v.sentinels.running < need) {
    return { server, tone: 'bad', text: `Only ${v.sentinels.running} of ${v.sentinels.desired} sentinels are running, fewer than the ${need} needed to vote, so nothing switches over.`, tech: `quorum ${need}` };
  }
  const on = serverList(serversOf(v, place, 'sentinel'));
  return {
    server,
    tone: 'ok',
    text: `${v.sentinels.running} sentinels${on ? ` on ${on}` : ''} vote (${need} of ${v.sentinels.desired} needed) and switch over to ${standbys.length > 1 ? `a standby copy on ${standbys.map((n) => n.name).join(' or ')}` : `the standby copy on ${standby}`}.`,
    tech: `quorum ${need} · ${env} names ${v.host}: only sentinel-aware clients (port 26379) follow a switch-over`,
  };
}

/** Apps → primary → standby copies, as diagram columns. */
export function cacheDiagram(v: CacheView, place: Placement, tech: boolean): { columns: FlowBox[][]; links: FlowLink[] } {
  const env = envVarOf(v);
  const apps: FlowBox[] = v.attachments.length
    ? v.attachments.map((a) => ({ key: `app:${a.service}`, title: short(a.service), meta: a.envVar, tone: 'info' }))
    : [{ key: 'app:none', title: 'no app yet', meta: env, tone: 'idle', ghost: true }];
  const box = (role: 'primary' | 'replica'): FlowBox[] =>
    v.members
      .filter((m) => m.role === role)
      .flatMap((m) => (place ? (place.get(m.service) ?? []) : [null]).map((n) => ({ m, n })))
      .map(({ m, n }) => ({
        key: `${m.service}@${n?.id ?? '-'}`,
        title: n?.name ?? short(m.service),
        chip: role === 'primary' ? (tech ? 'primary' : 'main') : tech ? 'replica' : 'standby',
        chipTone: role === 'primary' ? ('warn' as const) : undefined,
        meta: [n?.region, tech ? short(m.service) : null].filter(Boolean).join(' · ') || short(m.service),
        stat: role === 'primary' ? (tech ? `${m.running}/${m.desired} running` : 'takes every write') : tech ? `replicaof ${short(v.host)}` : 'copies every write',
        tone: m.status === 'running' ? ('ok' as const) : m.status === 'deploying' ? ('info' as const) : ('warn' as const),
      }));
  const primary = box('primary');
  const replicas = box('replica');
  const p = primary[0]?.key;
  const links: FlowLink[] = p
    ? [
        ...apps.map((a) => ({ from: a.key, to: p, label: a.ghost ? undefined : env, tone: 'info' as const, dashed: a.ghost })),
        ...replicas.map((r) => ({ from: p, to: r.key, label: tech ? 'replication' : 'every write', tone: 'warn' as const })),
      ]
    : [];
  return { columns: [apps, primary, replicas], links };
}

/** The sentinels in one line ("3 sentinels on mgr-1, mgr-2 and wkr-1"), or null. */
export function sentinelLine(v: CacheView, place: Placement): string | null {
  if (v.topology !== 'sentinel') return null;
  const on = serverList(serversOf(v, place, 'sentinel'));
  return `${v.sentinels.running} of ${v.sentinels.desired} sentinels running${on ? ` on ${on}` : ''}, watching the main copy`;
}
