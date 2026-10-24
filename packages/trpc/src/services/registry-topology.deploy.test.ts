import { describe, expect, it } from 'bun:test';
import { encryptSecret } from '@swarmy/core/crypto';
import type { OrgContext } from '../context';
import { rotateRegistryCredentials, setRegistryEnabled } from './cicd.service';
import { seedKv } from './swarm-kv.service';

process.env.SWARMY_SECRET_KEY ??= 'a'.repeat(64);

type Spec = { name: string; ports?: unknown[]; networks?: string[]; placement?: unknown };

/** One ready node (n1) whose agent reports the forwarder; optionally a registry task running there. */
function fakeCtx(opts: { forwarder?: 'on'; registry?: Record<string, unknown> }) {
  const deploys: Spec[] = [];
  const services = opts.registry ? [{ id: 'reg', name: 'swarmy-registry', image: 'registry:2', labels: {}, env: [], secrets: [], ...opts.registry }] : [];
  const containers = opts.registry ? [{ id: 'c', serviceId: 'reg', state: 'running', labels: { 'com.docker.swarm.node.id': 'swarmn1' } }] : [];
  const ctx = {
    activeOrgId: 'org1',
    user: { id: 'u1' },
    db: { auditLog: { create: async () => undefined } },
    hub: {
      isOnline: () => true,
      managerNode: () => 'n1',
      liveInventory: () => ({ services, containers }),
      nodeInventory: () => [{ swarmNodeId: 'swarmn1', status: 'ready' }],
      onlineNodeIds: () => ['n1'],
      swarmNodeIdFor: () => 'swarmn1',
      agentBuildFor: () => ({ version: '1', registryForwarder: opts.forwarder }),
      dispatch: async (_n: string, cmd: string, p: { spec?: Spec }) => {
        if (cmd === 'service.deploy' && p.spec) deploys.push(p.spec);
        return cmd === 'secret.list' ? { secrets: [] } : {};
      },
    },
  } as unknown as OrgContext;
  const creds = encryptSecret(JSON.stringify({ username: 'swarmy', password: 'p' }));
  seedKv(ctx.hub, 'org1', 'registry', 'org1', { enabled: !!opts.registry, host: 'localhost:5000', credentialsEnc: creds });
  return { ctx, deploys };
}

describe('registry deploys follow the org topology (M16)', () => {
  it('a fresh enable on a cluster where every node forwards deploys loopback straight away', async () => {
    const { ctx, deploys } = fakeCtx({ forwarder: 'on' });
    await setRegistryEnabled(ctx, { enabled: true });
    expect(deploys[0]).toMatchObject({ name: 'swarmy-registry', ports: [], networks: ['swarmy'] });
    expect(deploys[0]?.placement).toBeUndefined(); // nothing running yet: nowhere to pin
  });

  it('a fresh enable while a node cannot forward keeps the routing mesh', async () => {
    const { ctx, deploys } = fakeCtx({});
    await setRegistryEnabled(ctx, { enabled: true });
    expect(deploys[0]?.ports).toEqual([{ target: 5000, published: 5000, protocol: 'tcp', mode: 'ingress' }]);
  });

  it('a login rotation keeps a moved registry loopback and on the node that holds its volume', async () => {
    const { ctx, deploys } = fakeCtx({ registry: { ports: [], networks: [{ name: 'swarmy', aliases: [] }] } });
    await rotateRegistryCredentials(ctx);
    expect(deploys[0]).toMatchObject({ ports: [], placement: { constraints: ['node.id==swarmn1'] } });
  });

  it('a login rotation on an unmoved cluster keeps the mesh port (only the reconcile moves it)', async () => {
    const live = { ports: [{ target: 5000, published: 5000, protocol: 'tcp' }], networks: [{ name: 'swarmy', aliases: [] }] };
    const { ctx, deploys } = fakeCtx({ registry: live });
    await rotateRegistryCredentials(ctx);
    expect(deploys[0]?.ports).toEqual([{ target: 5000, published: 5000, protocol: 'tcp', mode: 'ingress' }]);
    expect(deploys[0]?.placement).toEqual({ constraints: ['node.id==swarmn1'] });
  });
});
