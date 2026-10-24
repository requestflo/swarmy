/**
 * TEST-ONLY fake for the managed-search service tests (indexes, settings, key
 * rotation): one Meilisearch instance `shop/main` running on `node-a`, a
 * policy-ready OrgContext, and a hub that records every dispatch. `exec`
 * answers come from `answer` (framed with the script's own marker); any other
 * command goes to `onCommand`. No socket, no DB.
 */
import type { OrgContext } from '../context';
import { seedKv, useMemoryKv } from './swarm-kv.service';

export const ENGINE = {
  id: 'svc-search', name: 'shop_main-search', image: 'getmeili/meilisearch:v1.12', mode: 'replicated',
  replicas: 1, runningReplicas: 1, desiredReplicas: 1,
  labels: { 'com.docker.stack.namespace': 'shop', 'swarmy.search.engine': 'meilisearch', 'swarmy.search.cluster': 'main' } as Record<string, string>,
  networks: [] as string[], env: [] as string[], ports: [], secrets: [] as string[], createdAt: 0, updatedAt: 0,
};
const container = {
  id: 'ctr-search', name: 'shop_main-search.1', image: ENGINE.image, state: 'running', status: 'Up',
  serviceId: 'svc-search', labels: { 'com.docker.swarm.service.id': 'svc-search' },
};

export interface Sent {
  node: string;
  cmd: string;
  payload: { cmd: string[] } & Record<string, unknown>;
}

export interface FakeOpts {
  labels?: Record<string, string>;
  /** More live services (attached apps). */
  services?: Array<typeof ENGINE>;
  onCommand?: (cmd: string, payload: Record<string, unknown>) => unknown;
}

export function ctxWith(role: 'owner' | 'member', answer: (script: string) => Array<[number, unknown]>, opts: FakeOpts = {}) {
  const audit: { action: string; metadata: Record<string, unknown> }[] = [];
  const sent: Sent[] = [];
  const engine = { ...ENGINE, labels: { ...ENGINE.labels, ...opts.labels } };
  const hub = {
    liveInventory: () => ({ services: [engine, ...(opts.services ?? [])], containers: [container] }),
    onlineNodeIds: () => ['node-a'],
    latestContainers: () => [container],
    managerNode: () => 'node-a',
    nodeInfoFor: () => undefined,
    nodeOrgId: () => 'org1',
    dispatch: async (node: string, cmd: string, payload: Sent['payload']) => {
      sent.push({ node, cmd, payload });
      if (cmd !== 'exec') return opts.onCommand?.(cmd, payload);
      const script = payload.cmd[2] ?? '';
      const marker = /-w '\\n(@@[a-z0-9]+) /.exec(script)?.[1] ?? '';
      const output = answer(script).map(([status, body]) => `${JSON.stringify(body)}\n${marker} ${status}\n`).join('');
      return { exitCode: 0, output };
    },
  };
  useMemoryKv(hub as never);
  seedKv(hub as never, 'org1', 'stack', 'st1', { name: 'shop', ingressDriver: null });
  const ctx = {
    activeOrgId: 'org1',
    user: { id: 'u1' },
    session: { id: 's1' },
    membership: { role, orgId: 'org1' },
    reqHeaders: new Headers(),
    db: {
      member: { findFirst: async () => ({ id: 'mem1', role, organizationId: 'org1', attributes: {} }) },
      policy: { findMany: async () => [] },
      resourceGrant: { findMany: async () => [] },
      auditLog: { create: async ({ data }: { data: { action: string; metadata: Record<string, unknown> } }) => void audit.push(data) },
    },
    hub,
  } as unknown as OrgContext;
  return { ctx, audit, sent };
}
