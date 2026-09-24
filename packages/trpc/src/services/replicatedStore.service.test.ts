import { describe, expect, it } from 'bun:test';
import { encryptSecret } from '@swarmy/core/crypto';
import type { OrgContext } from '../context';
import { GARAGE_MEMBER_NODE_LABEL } from './garage-render';
import {
  enable,
  garageCapacityGb,
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
  const good = {
    mode: 'global' as const,
    configs: ['swarmy-garage-config-abcd1234'],
    mounts: [{ type: 'volume', target: '/m' }],
    networks: [{ name: 'swarmy', aliases: [] }, { name: 'swarmy-control', aliases: [] }],
    ports: [],
    secrets: ['swarmy-garage-rpc-secret-11111111', 'swarmy-garage-admin-token-22222222'],
  };
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
  it('a store off the swarmy overlay converges (swarmy-garage:3900 resolves nowhere)', () => {
    expect(storeNeedsConverge({ ...good, networks: [] })).toBe(true);
    expect(storeNeedsConverge({ ...good, networks: undefined })).toBe(true);
    expect(storeNeedsConverge({ ...good, networks: [{ name: 'other', aliases: [] }] })).toBe(true);
  });
  it('a store off the control overlay converges (the controller replicates control.db into it)', () => {
    expect(storeNeedsConverge({ ...good, networks: [{ name: 'swarmy', aliases: [] }] })).toBe(true);
  });
  it('a store whose secrets are not mounted as Docker secrets converges (legacy secrets-in-toml)', () => {
    expect(storeNeedsConverge({ ...good, secrets: [] })).toBe(true);
    expect(storeNeedsConverge({ ...good, secrets: undefined })).toBe(true);
    expect(storeNeedsConverge({ ...good, secrets: ['swarmy-garage-rpc-secret-11111111'] })).toBe(true);
    expect(storeNeedsConverge({ ...good, secrets: ['swarmy-garage-admin-token-22222222'] })).toBe(true);
  });
  it('a store publishing ports on the routing mesh converges (private-only)', () => {
    expect(
      storeNeedsConverge({
        ...good,
        ports: [
          { target: 3900, published: 30006, protocol: 'tcp' },
          { target: 3903, published: 30007, protocol: 'tcp' },
        ],
      }),
    ).toBe(true);
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
      adminTokenRef: encryptSecret('gadm_fake-admin-token-XYZ'),
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
          if (cmd === 'secret.list') {
            return {
              secrets: [
                { name: 'swarmy-garage-rpc-secret-00000000' },
                { name: 'swarmy-garage-admin-token-00000000' },
                { name: 'app-db-password' },
              ],
            };
          }
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
    expect((rendered as unknown as { networks: string[] }).networks).toEqual(['swarmy', 'swarmy-control']);

    // The overlay is ensured (attachable) before the service references it.
    const ensure = dispatched.findIndex((d) => d.cmd === 'network.ensure');
    expect(ensure).toBeGreaterThanOrEqual(0);
    expect(dispatched[ensure]!.payload).toMatchObject({ name: 'swarmy', driver: 'overlay', attachable: true });
    expect(ensure).toBeLessThan(dispatched.findIndex((d) => d.cmd === 'storage.apply'));

    // Superseded config swept after the apply.
    expect(dispatched.find((d) => d.cmd === 'config.remove')?.payload.name).toBe('swarmy-garage-config-00000000');

    // Secrets: created as Docker SECRETS before the apply, attached to the
    // service, and ABSENT from the config (which anyone on a manager can read).
    const secretCreates = dispatched.filter((d) => d.cmd === 'secret.create');
    expect(secretCreates.map((d) => d.payload.name as string)).toEqual([
      expect.stringMatching(/^swarmy-garage-rpc-secret-[0-9a-f]{8}$/),
      expect.stringMatching(/^swarmy-garage-admin-token-[0-9a-f]{8}$/),
    ]);
    const values = secretCreates.map((d) => Buffer.from(d.payload.dataB64 as string, 'base64').toString('utf8'));
    expect(values[1]).toBe('gadm_fake-admin-token-XYZ');
    expect(isValidGarageRpcSecret(values[0]!)).toBe(true);
    for (const v of values) expect(toml).not.toContain(v);
    expect(toml).toContain('rpc_secret_file = "/run/secrets/garage-rpc-secret"');
    expect(toml).toContain('admin_token_file = "/run/secrets/garage-admin-token"');
    const applyIdx = dispatched.findIndex((d) => d.cmd === 'storage.apply');
    for (const c of secretCreates) expect(dispatched.indexOf(c)).toBeLessThan(applyIdx);
    expect((rendered as unknown as { secrets: Array<{ source: string }> }).secrets.map((s) => s.source)).toEqual(
      secretCreates.map((d) => d.payload.name as string),
    );

    // Superseded store secrets swept; foreign secrets untouched.
    expect(dispatched.filter((d) => d.cmd === 'secret.remove').map((d) => d.payload.name)).toEqual([
      'swarmy-garage-rpc-secret-00000000',
      'swarmy-garage-admin-token-00000000',
    ]);
  });
});

describe('garageRpcSecret', () => {
  it('is 32 bytes hex — the only rpc_secret Garage boots with', () => {
    const s = garageRpcSecret();
    expect(isValidGarageRpcSecret(s)).toBe(true);
    expect(isValidGarageRpcSecret('grpc_abc123')).toBe(false);
  });
});

describe('garageCapacityGb', () => {
  it('uses 80% of the real disk, never the 100 GB default when stats exist', () => {
    expect(garageCapacityGb(25_000_000_000)).toBe(20);
    expect(garageCapacityGb(500_000_000)).toBe(1);
    expect(garageCapacityGb(null)).toBe(100);
  });
});
