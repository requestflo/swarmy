import type { AppRouter } from '@swarmy/trpc';
import type { DemoStore, DomainResolvers } from '../types';
import { managedMemberServers } from './managed-members';

/**
 * Demo `db.replication` (Postgres page, board 39): `pg_stat_replication` on
 * the main copy, one row per running standby task, on the servers the demo
 * places them (managed-members.ts). The story: data/main's two standbys are
 * caught up or a few hundred bytes behind; so is checkout's one standby (a
 * standby with 5 s or more of lag reads 38 MB behind). Roles come from the
 * demo topology, so after a demo switch-over the old main copy is the standby.
 * The primary's LSN moves with the clock so the page reads as live.
 */

type Out<T> = T extends { _def: { $types: { output: infer X } } } ? X : never;
type View = Out<AppRouter['_def']['record']['db']['replication']>;
type Standby = View['standbys'][number];

interface DbTopo {
  stack: string;
  cluster: string;
  members: Array<{ service: string; role: string; running: number; lagSeconds?: number }>;
}

const MB = 1024 * 1024;
const lsn = (pos: number): string => `${Math.floor(pos / 0x1_0000_0000).toString(16).toUpperCase()}/${(pos % 0x1_0000_0000).toString(16).toUpperCase()}`;
const host = (service: string, i: number): string => {
  let h = 0x811c9dc5;
  for (const c of `${service}#${i}`) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return `${h.toString(16).padStart(8, '0')}${(h >>> 16).toString(16).padStart(4, '0')}`.slice(0, 12);
};

export function demoReplication(s: DemoStore, stack: string, cluster: string): View {
  const topo = ((s.extra.data as { dbTopologies?: DbTopo[] } | undefined)?.dbTopologies ?? []).find((t) => t.stack === stack && t.cluster === cluster);
  if (!topo) throw new Error(`database "${stack}/${cluster}" not found`);
  const primaryPos = 0x16_0000_0000 + Math.floor(Date.now() / 50) % 0x4000_0000;
  const standbys: Standby[] = [];
  for (const m of topo.members.filter((x) => x.role === 'replica')) {
    managedMemberServers(s, m.service).forEach((nodeId, i) => {
      const slow = (m.lagSeconds ?? 0) >= 5;
      const behind = slow ? 38 * MB : i === 0 ? 0 : 232;
      const replay = primaryPos - behind;
      standbys.push({
        name: host(m.service, i),
        addr: `10.0.4.${7 + standbys.length * 2}/32`,
        state: 'streaming',
        syncState: 'async',
        sentLsn: lsn(primaryPos),
        replayLsn: lsn(replay),
        lagBytes: behind,
        lagSeconds: slow ? (m.lagSeconds ?? 14.2) : behind === 0 ? null : 0.4,
        service: m.service,
        nodeId,
      });
    });
  }
  return { stack, cluster, measuredAt: new Date().toISOString(), primaryLsn: lsn(primaryPos), standbys };
}

export const pgReplication: DomainResolvers = {
  handlers: {
    'db.replication': (i, s) => {
      const { stack, cluster } = i as { stack: string; cluster: string };
      return demoReplication(s, stack, cluster);
    },
  },
};
