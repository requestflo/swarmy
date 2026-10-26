import type { NodeSummary, ServiceDetail } from '@swarmy/core';
import { copyBlock, copyBody, copyElsewhere } from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * Demo ⌥-drag (board 9): `services.copyPlan` and `services.addCopy`. The
 * demo places a service's copies round-robin over the online servers from a
 * per-service start (`runsOn` in core.ts), so one more copy lands on the
 * next server in that rotation: dropping it anywhere else is refused in the
 * real words, as are stateful, pinned and swarmy-owned services.
 */

type Answer = { ok: false; reason: string } | { ok: true; replicas: number; body: string; note: null };

const startOf = (id: string, n: number): number => {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % n;
};

function answer(store: DemoStore, id: string, to: string): Answer & { service: string; to: string } {
  const sv = store.services.find((s) => s.id === id || s.name === id) as ServiceDetail | undefined;
  if (!sv) throw new Error(`service "${id}" not found`);
  const nodes = store.nodes as NodeSummary[];
  const target = nodes.find((n) => n.id === to);
  const T = target?.name ?? to;
  const out = (a: Answer) => ({ ...a, service: sv.name, to });
  const block = copyBlock(
    {
      short: sv.name,
      mode: 'replicated',
      desired: sv.replicas.desired,
      system: sv.stackId === 's-system',
      labels: {},
      volumes: sv.volumes.filter((v) => v.type === 'volume' && v.source).map((v) => v.source!),
    },
    T,
  );
  if (block) return out({ ok: false, reason: block });
  if (target?.status !== 'online') return out({ ok: false, reason: `${T} isn't ready for work right now.` });
  if (sv.nodeId && sv.nodeId !== to) {
    const rule = sv.constraints[0] ?? `node.id == swarm-${sv.nodeId}`;
    return out({ ok: false, reason: `${sv.name}'s placement rules keep it off ${T} (${rule}). Change them under its Placement first.` });
  }
  if (!sv.nodeId) {
    const online = nodes.filter((n) => n.status === 'online');
    const next = online[(startOf(sv.id, online.length) + sv.replicas.running) % online.length]!;
    if (next.id !== to) return out({ ok: false, reason: copyElsewhere(sv.name, next.name, T) });
  }
  return out({ ok: true, replicas: sv.replicas.desired + 1, body: copyBody(sv.name, sv.replicas.desired, T), note: null });
}

export const addCopyDemo: DomainResolvers = {
  handlers: {
    'services.copyPlan': (i, store) => {
      const { id, toNodeId } = i as { id: string; toNodeId: string };
      return answer(store, id, toNodeId);
    },
    'services.addCopy': (i, store) => {
      const { id, toNodeId } = i as { id: string; toNodeId: string };
      const a = answer(store, id, toNodeId);
      if (!a.ok) throw new Error(a.reason);
      const sv = store.services.find((s) => s.name === a.service)!;
      sv.replicas = { desired: a.replicas, running: a.replicas };
      sv.updatedAt = new Date().toISOString();
      return { service: sv.name, replicas: a.replicas, to: store.nodes.find((n) => n.id === toNodeId)?.name ?? toNodeId };
    },
  },
};
