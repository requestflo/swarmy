/**
 * TEST-ONLY world for the ingress settings write tests: an org on Caddy with
 * a running edge task, a cert store and object storage, in-memory swarm-kv,
 * and a hub that records every dispatch. Its inventory LAGS a deploy (as a
 * real one can), so a re-deploy would show as a second command. No socket, no DB.
 */
import type { ContainerInfo, ServiceSpec, SwarmServiceInfo } from '@swarmy/core/protocol';
import { encryptSecret } from '@swarmy/core/crypto';
import type { OrgContext } from '../context';
import { peekKv, seedKv, useMemoryKv } from './swarm-kv.service';

process.env.SWARMY_SECRET_KEY ??= 'a'.repeat(64);

export const EDGE = 'swarmy-ingress-caddy';
export const TUNNEL_ID = '0123456789abcdef0123456789abcdef';
export const RUN_TOKEN = Buffer.from(JSON.stringify({ a: 'acct', t: TUNNEL_ID, s: 'tunnel-secret-xyz' })).toString('base64');
export const DNS_TOKEN = 'cf-dns-token-0123456789-DO-NOT-LEAK';
export const CERTS = {
  kind: 's3', endpoint: 'http://swarmy-garage:3900', bucket: 'swarmy-edge-certs', bucketId: 'b1', region: 'garage',
  prefix: 'caddy-enc/org_s', accessKeyId: 'GK1', secretName: 'swarmy-edge-certs-GK1', encSecretName: 'swarmy-edge-certs-enc-1',
};

export type WorldOpts = { mode?: 'replicated' | 'global'; settings?: Record<string, unknown>; ingressNode?: boolean; failGlobal?: boolean; fresh?: boolean };

export function world(opts: WorldOpts = {}) {
  const sent: Array<{ cmd: string; payload: any }> = [];
  const audit: Array<{ action: string; metadata: any }> = [];
  // `fresh`: no edge service and no task yet (a brand-new org).
  const services: SwarmServiceInfo[] = opts.fresh ? [] : [{
    id: 's1', name: EDGE, image: 'caddy', mode: opts.mode ?? 'replicated', desiredReplicas: 1, runningReplicas: 1, createdAt: 0,
    updatedAt: 0, labels: {}, networks: [], env: [], ports: [], secrets: [], configs: [],
  }];
  const task: ContainerInfo = { id: 'c1', name: `${EDGE}.1`, image: 'caddy', state: 'running', status: 'Up', createdAt: 0, ports: [], labels: { 'com.docker.swarm.service.name': EDGE } };
  const db = {
    node: { findMany: async () => [{ id: 'm1' }] },
    statusPage: { findMany: async () => [] },
    inboundEndpoint: { findMany: async () => [] },
    aiProviderConfig: { findUnique: async () => null },
    auditLog: { create: async ({ data }: any) => void audit.push({ action: data.action, metadata: data.metadata }) },
  };
  const hub = {
    isOnline: () => true, managerNode: () => 'm1', managerNodes: () => ['m1'], swarmNodeIdFor: () => undefined,
    nodeInventory: () => [{ swarmNodeId: 'sw1', hostname: 'a', role: 'manager', availability: 'active', status: 'ready', leader: true, labels: opts.ingressNode === false ? {} : { 'swarmy.node.ingress': 'true' } }],
    nodeInfoFor: () => ({ hostname: 'a', labels: {} }),
    liveInventory: () => ({ services, containers: [] }),
    latestContainers: () => (opts.fresh ? [] : [task]),
    dispatch: async (_n: string, cmd: string, payload: any) => {
      sent.push({ cmd, payload });
      if (cmd === 'secret.list') return { secrets: [CERTS.secretName, CERTS.encSecretName].map((name) => ({ id: name, name })) };
      if (cmd === 'service.remove') services.splice(0, 1);
      if (cmd === 'service.deploy' && opts.failGlobal && 'global' in ((payload.spec as ServiceSpec).mode ?? {})) throw new Error('pull failed');
      return {};
    },
  };
  const ctx = { db, hub, activeOrgId: 'org_s', user: { id: 'u1' } } as unknown as OrgContext;
  useMemoryKv(hub as never);
  seedKv(hub as never, 'org_s', 'ingress', 'org_s', { driver: 'CADDY', enabled: true, settings: { certStorage: CERTS, ...opts.settings } });
  seedKv(hub as never, 'org_s', 'storage', 'org_s', { enabled: true, driver: 'GARAGE', region: 'garage', adminTokenRef: encryptSecret('t'), memberNodeIds: ['m1'] });
  const doc = () => peekKv<{ driver: string; settings: Record<string, any> }>(hub as never, 'org_s', 'ingress', 'org_s')!;
  const count = (c: string) => sent.filter((s) => s.cmd === c).length;
  return { ctx, sent, audit, doc, count };
}
