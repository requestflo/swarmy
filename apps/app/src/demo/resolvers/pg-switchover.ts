import {
  SWITCHOVER_BUSY,
  SWITCHOVER_PHASES,
  newSwitchoverRun,
  planSwitchover,
  withSwitchoverStep,
  type DbPoolerView,
  type DbSwitchoverRunView,
} from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';
import { managedMemberServers } from './managed-members';
import { pgPoolerDemo } from './pg-pooler';
import { demoReplication } from './pg-replication';

/**
 * Demo `db.switchover` / `db.switchoverRun` (boards 39 and 15). The SAME pure
 * plan the controller runs — copies from the demo topology, standbys from the
 * demo `db.replication`, apps from the demo `db.pooler` — then a run that
 * walks its steps on a clock (pause, catch up, promote, repoint, rejoin, about
 * 8 s) and swaps the writer and the standby in the demo topology once the
 * promotion lands. The story: storefront/checkout's standby on mgr-2 is caught
 * up and both its apps go through the pooler, so it can take the writes;
 * data/main can't yet (data_worker connects straight to the main copy, and its
 * two standbys share one service).
 */

interface Topo {
  stack: string;
  cluster: string;
  topology: string;
  leader?: string;
  members: Array<{ service: string; role: string; status: string; desired: number; running: number; lagSeconds?: number }>;
}
interface Run {
  first: DbSwitchoverRunView;
  at: number;
  swapped: boolean;
}

/** Each step's end, ms after the start: pause, catch up, promote, repoint, rejoin. */
const ENDS = [1_200, 2_600, 4_800, 6_200, 8_500];
const PAUSED_S = 4;
const ref = (i: unknown) => i as { stack: string; cluster: string; target?: string };
const runs = (s: DemoStore) => (s.extra.pgSwitchover ??= {}) as Record<string, Run>;
const topoOf = (s: DemoStore, stack: string, cluster: string): Topo | undefined =>
  ((s.extra.data as { dbTopologies?: Topo[] } | undefined)?.dbTopologies ?? []).find((t) => t.stack === stack && t.cluster === cluster);

function copyName(s: DemoStore, service: string): string {
  const id = managedMemberServers(s, service)[0];
  const node = id ? s.nodes.find((n) => n.id === id) : undefined;
  return node ? `${node.name}'s copy` : service;
}

function said(s: DemoStore, r: Run, i: number): string {
  const [from, to] = [copyName(s, r.first.from), copyName(s, r.first.target)];
  return [
    "Writes paused; the main copy's last change is at 16/2A3F1C8.",
    `${to} has every change.`,
    `${to} takes the writes. Writes were paused for ${PAUSED_S} s.`,
    'The other copies and the pooler follow the new writer.',
    `${from} follows ${to}.`,
  ][i]!;
}

/** The run as it stands now; the promotion swaps the demo roles once. */
function project(s: DemoStore, r: Run): DbSwitchoverRunView {
  const el = Date.now() - r.at;
  let v = r.first;
  SWITCHOVER_PHASES.forEach((p, i) => {
    const start = i === 0 ? 0 : ENDS[i - 1]!;
    if (el >= ENDS[i]!) v = withSwitchoverStep(v, p.phase, 'done', said(s, r, i), new Date(r.at + ENDS[i]!).toISOString());
    else if (el >= start) v = withSwitchoverStep(v, p.phase, 'running');
  });
  if (el >= ENDS[2]!) {
    v = { ...v, pausedSeconds: PAUSED_S };
    const t = topoOf(s, v.stack, v.cluster);
    if (t && !r.swapped) {
      r.swapped = true;
      for (const m of t.members) {
        if (m.role === 'primary') m.role = 'replica';
        else if (m.service === v.target) m.role = 'primary';
      }
      t.leader = v.target;
    }
  }
  return v;
}

export const pgSwitchoverDemo: DomainResolvers = {
  handlers: {
    'db.switchover': (i, s) => {
      const { stack, cluster, target } = ref(i);
      const t = topoOf(s, stack, cluster);
      if (!t) throw new Error(`db cluster "${stack}/${cluster}" not found`);
      const key = `${stack}/${cluster}`;
      const live = runs(s)[key];
      const pooler = pgPoolerDemo.handlers!['db.pooler']!({ stack, cluster }, s) as DbPoolerView;
      const plan = planSwitchover({
        cluster,
        topology: t.topology,
        members: t.members,
        standbys: demoReplication(s, stack, cluster).standbys,
        busy: live && project(s, live).status === 'running' ? SWITCHOVER_BUSY.running : null,
        directApps: pooler.apps.filter((a) => a.via !== 'pooler').map((a) => a.service).sort(),
        ...(target ? { target } : {}),
        copyName: (svc) => copyName(s, svc),
      });
      if (!plan.ok) throw new Error(plan.reason);
      const at = Date.now();
      const first = newSwitchoverRun({
        runId: `sw_${at.toString(16)}`,
        stack,
        cluster,
        from: plan.from,
        target: plan.target,
        targetNodeId: plan.nodeId,
        startedAt: new Date(at).toISOString(),
      });
      runs(s)[key] = { first, at, swapped: false };
      return withSwitchoverStep(first, 'pause', 'running');
    },
    'db.switchoverRun': (i, s) => {
      const { stack, cluster } = ref(i);
      const r = runs(s)[`${stack}/${cluster}`];
      return r ? project(s, r) : null;
    },
  },
};
