import type { MoveState, MoveStep, NodeDetail } from '@swarmy/core';
import { MOVE_STATE_LABEL } from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * Demo `decommission.moveService` (boards 9 + 11): moving a service's data
 * to another server. Mirrors the real mover's shape: the call returns at
 * once, progress is the service's `swarmy.move.state` label (merged into
 * `inventory.get` by `moveLabels`), and at the end the service is pinned to
 * the new server. Like the real router, a move the mover would refuse up
 * front (no data, several copies, an unready server) simply never starts.
 *
 * Seeds the data the move needs: named volumes on the stateful services
 * (surfaced as Mounts by `services.inspect`) and wkr-1 behind NAT (it has
 * no public address and is reached over the private network).
 */

const VOLUMES: Record<string, { source: string; target: string }> = {
  'svc-postgres': { source: 'data_pgdata', target: '/var/lib/postgresql/data' },
  'svc-redis': { source: 'data_redis', target: '/data' },
  'svc-grafana': { source: 'platform_grafana', target: '/var/lib/grafana' },
  'svc-prometheus': { source: 'platform_prometheus', target: '/prometheus' },
};

/** Seconds into the move each step starts (the demo's whole move takes ~15 s). */
const STEPS: [MoveStep, number][] = [
  ['serve', 0],
  ['copy-live', 2],
  ['stop', 6],
  ['copy-final', 8],
  ['verify', 10],
  ['repin', 12],
  ['start', 13],
];
const DONE_AT_S = 15;

function moves(store: DemoStore): Record<string, MoveState> {
  return (store.extra.moves ??= {}) as Record<string, MoveState>;
}

/** The `swarmy.move.state` label for a service while its demo move runs. */
export function moveLabels(store: DemoStore, serviceId: string): Record<string, string> {
  const m = moves(store)[serviceId];
  return m ? { [MOVE_STATE_LABEL]: JSON.stringify(m) } : {};
}

export const movesDemo: DomainResolvers = {
  seed: (store) => {
    for (const sv of store.services) {
      const v = VOLUMES[sv.id];
      if (v) sv.volumes = [{ type: 'volume', source: v.source, target: v.target, readOnly: false }];
    }
    const nat = store.nodes.find((n) => n.id === 'n-wkr-1') as NodeDetail | undefined;
    if (nat) nat.labels = { ...nat.labels, 'swarmy.node.reachability': 'nat' };
  },
  handlers: {
    'decommission.moveService': (i, store) => {
      const { service, toNodeId } = i as { service: string; toNodeId: string };
      const sv = store.services.find((s) => s.name === service);
      if (!sv) throw new Error(`no service named ${service}`);
      const to = store.nodes.find((n) => n.id === toNodeId);
      const ok =
        sv.nodeId &&
        sv.nodeId !== toNodeId &&
        sv.replicas.desired <= 1 &&
        sv.volumes.some((v) => v.type === 'volume' && v.source) &&
        to?.status === 'online' &&
        !moves(store)[sv.id];
      if (!ok) return { started: true, service };
      const state: MoveState = {
        id: `mv-${Date.now().toString(36)}`,
        step: 'serve',
        from: sv.nodeId!,
        to: toNodeId,
        volumes: sv.volumes.map((v) => v.source!).filter(Boolean),
        replicas: sv.replicas.desired,
        startedAt: new Date().toISOString(),
      };
      moves(store)[sv.id] = state;
      for (const [step, at] of STEPS) setTimeout(() => moves(store)[sv.id] && (moves(store)[sv.id] = { ...state, step }), at * 1000);
      setTimeout(() => {
        sv.nodeId = toNodeId;
        sv.constraints = [`node.id == swarm-${toNodeId}`];
        delete moves(store)[sv.id];
      }, DONE_AT_S * 1000);
      return { started: true, service };
    },
  },
};
