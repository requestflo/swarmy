import { describe, expect, it } from 'bun:test';
import { encryptSecret } from '@swarmy/core/crypto';
import type { OrgContext } from '../context';
import { GARAGE_MEMBER_NODE_LABEL } from './garage-render';
import {
  enable,
  garageRpcSecret,
  isValidGarageRpcSecret,
  pickDefaultMembers,
  storeNeedsConverge,
} from './replicatedStore.service';

process.env.SWARMY_SECRET_KEY ??= 'a'.repeat(64);

describe('pickDefaultMembers', () => {
  const c = (id: string, over: Partial<{ online: boolean; inSwarm: boolean; storageRole: boolean }> = {}) => ({
    id,
    online: true,
    inSwarm: true,
    storageRole: false,
    ...over,
  });
  it('defaults to EVERY eligible online swarm node (2-node swarm ⇒ 2 members)', () => {
    expect(pickDefaultMembers([c('mgr'), c('wrk')])).toEqual(['mgr', 'wrk']);
  });
  it('prefers storage-role nodes when any are labelled', () => {
    expect(pickDefaultMembers([c('a'), c('b', { storageRole: true })])).toEqual(['b']);
  });
  it('skips offline nodes and nodes not in the swarm', () => {
    expect(pickDefaultMembers([c('a', { online: false }), c('b', { inSwarm: false }), c('c')])).toEqual(['c']);
  });
});

describe('storeNeedsConverge', () => {
  const good = { mode: 'global' as const, configs: ['swarmy-garage-config-abcd1234'], mounts: [{ type: 'volume', target: '/m' }] };
  it('converged service is a no-op', () => {
    expect(storeNeedsConverge(good)).toBe(false);
  });
  it('legacy host-bind spec converges', () => {
    expect(
      storeNeedsConverge({
        mode: 'replicated',
        configs: [],
        mounts: [{ type: 'bind', source: '/etc/swarmy/swarmy-garage/garage.toml', target: '/etc/garage.toml' }],
      }),
    ).toBe(true);
  });
  it('missing, config-less or unpinned (replicated) services converge', () => {
    expect(storeNeedsConverge(undefined)).toBe(true);
    expect(storeNeedsConverge({ ...good, configs: [] })).toBe(true);
    expect(storeNeedsConverge({ ...good, mode: 'replicated' })).toBe(true);
  });
});

describe('enable — 2-node swarm, no explicit members', () => {
  function fakeCtx() {
    const dispatched: Array<{ node: string; cmd: string; payload: Record<string, unknown> }> = [];
    let row = {
      id: 'sc1',
      orgId: 'org1',
      driver: 'GARAGE',
      enabled: false,
      replicationFactor: 3,
      region: 'swarmy',
      memberNodeIds: [] as string[],
      rpcSecretRef: encryptSecret('rpc'),
      adminTokenRef: encryptSecret('adm'),
      accessKeyRef: null,
      secretKeyRef: null,
      layout: {},
      updatedAt: new Date(0),
    };
    const swarmIds: Record<string, string> = { mgr: 'swarm-mgr', wrk: 'swarm-wrk' };
    const ctx = {
      activeOrgId: 'org1',
      user: { id: 'u1' },
      db: {
        storageCluster: {
          findUnique: async () => row,
          update: async ({ data }: { data: Partial<typeof row> }) => (row = { ...row, ...data }),
        },
        node: { findMany: async () => [{ id: 'mgr' }, { id: 'wrk' }] },
        auditLog: { create: async () => ({}) },
      },
      hub: {
        isOnline: () => true,
        managerNode: () => 'mgr',
        swarmNodeIdFor: (id: string) => swarmIds[id],
        nodeInfoFor: () => ({ labels: {} }),
        nodeInventory: () => [
          { swarmNodeId: 'swarm-old', labels: { [GARAGE_MEMBER_NODE_LABEL]: 'true' } },
          { swarmNodeId: 'swarm-mgr', labels: {} },
        ],
        liveInventory: () => ({ services: [], containers: [] }),
        dispatch: async (node: string, cmd: string, payload: Record<string, unknown>) => {
          dispatched.push({ node, cmd, payload });
          if (cmd === 'config.list') return { configs: [{ name: 'swarmy-garage-config-00000000' }] };
          return {};
        },
      },
    } as unknown as OrgContext;
    return { ctx, dispatched, getRow: () => row };
  }

  it('uses both nodes, clamps replication 3→2, pins via node labels, deploys once via the manager with a Docker config', async () => {
    const { ctx, dispatched, getRow } = fakeCtx();
    const view = await enable(ctx);

    expect(view.memberNodeIds).toEqual(['mgr', 'wrk']);
    expect(view.replicationFactor).toBe(2);
    expect(getRow().replicationFactor).toBe(2);

    // Every dispatch goes through the manager (workers cannot create services / update nodes).
    expect(new Set(dispatched.map((d) => d.node))).toEqual(new Set(['mgr']));

    const labelWrites = dispatched.filter((d) => d.cmd === 'node.update');
    expect(labelWrites.map((d) => [d.payload.swarmNodeId, (d.payload.labels as Record<string, string>)[GARAGE_MEMBER_NODE_LABEL]])).toEqual([
      ['swarm-mgr', 'true'],
      ['swarm-wrk', 'true'],
      ['swarm-old', 'false'], // ex-member unpinned
    ]);

    const create = dispatched.find((d) => d.cmd === 'config.create')!;
    expect(create.payload.name).toMatch(/^swarmy-garage-config-[0-9a-f]{8}$/);
    const toml = Buffer.from(create.payload.dataB64 as string, 'base64').toString('utf8');
    expect(toml).toContain('replication_factor = 2');

    const applies = dispatched.filter((d) => d.cmd === 'storage.apply');
    expect(applies).toHaveLength(1);
    const rendered = applies[0]!.payload.rendered as {
      files: unknown[];
      configs: Array<{ source: string }>;
      serviceMode: string;
    };
    expect(rendered.files).toEqual([]);
    expect(rendered.configs[0]!.source).toBe(create.payload.name as string);
    expect(rendered.serviceMode).toBe('global');

    // Superseded config swept after the apply.
    expect(dispatched.find((d) => d.cmd === 'config.remove')?.payload.name).toBe('swarmy-garage-config-00000000');
  });
});

describe('garageRpcSecret', () => {
  it('is 32 bytes hex — the only rpc_secret Garage boots with', () => {
    const s = garageRpcSecret();
    expect(isValidGarageRpcSecret(s)).toBe(true);
    expect(isValidGarageRpcSecret('grpc_abc123')).toBe(false);
  });
});
