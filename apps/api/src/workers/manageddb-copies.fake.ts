import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import { hub } from '../gateway';
import { fakeSwarm } from './manageddb-apps.fake';

/**
 * TEST HELPER — `fakeSwarm` with real COPIES: a service runs one task per
 * swarm node (`swarm-a|b|c`, reached through agents `a-swarm-*`), placed by
 * its spec's `node.id==` / `node.id!=` constraints and replica count, the way
 * managed Postgres members are (one copy per server). Each copy's Postgres
 * state lives with its server (`<service>@<node>`, like a node-local volume):
 * its replay LSN, and whether `pg_promote()` ever ran there. Every exec is
 * recorded with the container it ran in. `nodeLabels` gives servers labels
 * (`swarmy.region`), and a `node.labels.<k>==<v>` constraint places by them.
 */

const NODES = ['swarm-a', 'swarm-b', 'swarm-c'];
const agentOf = (node: string) => `a-${node}`;

export function copiesSwarm(orgId: string, nodeLabels: Record<string, Record<string, string>> = {}) {
  const base = fakeSwarm(orgId);
  /** `<service>@<node>` whose data has been promoted (a writer). */
  const writers = new Set<string>();
  /** `<service>@<node>` → replay LSN its probe reports (default `0/3000000`). */
  const replay = new Map<string, string>();
  /** Promote execs whose reply is lost once (the exec landed, the answer didn't). */
  const loseReply = new Set<string>();
  const execs: Array<{ copy: string; script: string }> = [];

  const nodesOf = (name: string): string[] => {
    const svc = base.services.get(name);
    if (!svc || svc.down) return [];
    const cons = svc.spec.placement?.constraints ?? [];
    const pin = cons.map((c) => /^node\.id==(\S+)$/.exec(c)?.[1]).find(Boolean);
    const avoid = new Set(cons.map((c) => /^node\.id!=(\S+)$/.exec(c)?.[1]).filter(Boolean));
    const want = svc.spec.mode?.replicated?.replicas ?? 1;
    const fits = (n: string) =>
      cons.every((c) => {
        const m = /^node\.labels\.(.+?)==(.+)$/.exec(c);
        return !m || nodeLabels[n]?.[m[1]!] === m[2];
      });
    return (pin ? [pin] : NODES.filter((n) => !avoid.has(n))).filter(fits).slice(0, want);
  };
  const containerOf = (name: string, node: string) => `c-${name}-${base.services.get(name)!.gen}-${node}`;
  const containers = () =>
    [...base.services.keys()].flatMap((name) =>
      nodesOf(name).map((node) => ({ id: containerOf(name, node), serviceId: `id-${name}`, state: 'running', createdAt: 0, labels: {}, node })),
    );
  const copyOf = (containerId: string) => containers().find((c) => c.id === containerId);
  const info = (name: string): SwarmServiceInfo => ({ ...base.info(name), runningReplicas: nodesOf(name).length });

  let baseDispatch: (node: string, cmd: string, payload: any, opts?: any) => Promise<any> = async () => ({});
  const dispatch = async (node: string, cmd: string, payload: any, opts?: any): Promise<any> => {
    if (cmd === 'service.scale') {
      const svc = base.services.get(payload.service)!;
      svc.spec = { ...svc.spec, mode: { replicated: { replicas: payload.replicas } } };
      base.calls.push({ cmd, payload });
      return {};
    }
    const c = cmd === 'exec' ? copyOf(payload.target.containerId) : undefined;
    if (!c) return baseDispatch(node, cmd, payload, opts);
    const name = c.serviceId.slice(3);
    const copy = `${name}@${c.node}`;
    const script = String(payload.cmd[2] ?? payload.cmd.join(' '));
    execs.push({ copy, script });
    if (script.includes('pg_promote')) {
      writers.add(copy);
      if (loseReply.delete(copy)) return { exitCode: 1, output: 'connection reset' };
      return { exitCode: 0, output: 't' };
    }
    if (script.includes('pg_is_in_recovery()::text')) return { exitCode: 0, output: `${!writers.has(copy)}|0|${replay.get(copy) ?? '0/3000000'}` };
    if (script.includes('pg_is_in_recovery')) return { exitCode: 0, output: writers.has(copy) ? 'f' : 't' };
    return baseDispatch(node, cmd, { ...payload, target: { containerId: `c-${name}-${base.services.get(name)!.gen}` } }, opts);
  };

  const overrides = {
    liveInventory: (o: string) =>
      o === orgId ? { services: [...base.services.keys()].map(info), containers: containers() } : { services: [], containers: [] },
    latestContainers: (agent: string) => containers().filter((c) => agentOf(c.node) === agent),
    onlineNodeIds: () => NODES.map(agentOf),
    swarmNodeIdFor: (agent: string) => agent.replace(/^a-/, ''),
    nodeInventory: () => NODES.map((n) => ({ swarmNodeId: n, hostname: n, role: 'worker', status: 'ready', availability: 'active', labels: nodeLabels[n] ?? {} })),
  };
  return {
    ...base,
    writers,
    replay,
    loseReply,
    execs,
    info,
    nodesOf,
    install: () => {
      base.install();
      baseDispatch = (hub as unknown as { dispatch: typeof baseDispatch }).dispatch;
      Object.assign(hub, overrides, { dispatch });
    },
    uninstall: () => {
      for (const k of [...Object.keys(overrides), 'dispatch']) delete (hub as unknown as Record<string, unknown>)[k];
      base.uninstall();
    },
  };
}
