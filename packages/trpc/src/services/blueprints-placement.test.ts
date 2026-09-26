import { describe, expect, it } from 'bun:test';
import { parse as parseYaml } from 'yaml';
import type { ServiceSpec } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { deployBlueprint, planBlueprint } from './blueprints.service';
import { pinComposeToNode } from './blueprints/placement';

/**
 * Q3 (owner, 2026-09-26): "Pick a server" pins a template deploy to one Ready
 * server of the org — `node.id==<swarm id>` on every service it creates.
 */

const ALL_OFF = ['noLatestTagInProd', 'minDbReplicasProd', 'requireBackupPolicy', 'requireHealthcheck', 'requireResourceLimits', 'requireSignedImagesProd', 'noPrivilegedContainers', 'noHostPortsProd'].map(
  (id) => ({ id, enabled: false, severity: 'block' }),
);

const NODES = [
  { id: 'n1', name: 'mgr-1', swarm: 'swarm-1', online: true },
  { id: 'n2', name: 'wkr-2', swarm: 'swarm-2', online: true },
  { id: 'n3', name: 'wkr-3', swarm: 'swarm-3', online: false },
];

function fakeCtx() {
  const deployed: ServiceSpec[] = [];
  const live = new Map<string, ServiceSpec>();
  const ctx = {
    activeOrgId: 'org1',
    user: { id: 'user1' },
    membership: { role: 'admin', orgId: 'org1' },
    db: {
      node: {
        findFirst: async ({ where }: { where: { orgId: string; id: string } }) =>
          where.orgId === 'org1' ? (NODES.find((n) => n.id === where.id) ?? null) : null,
        findMany: async () => NODES.map((n) => ({ id: n.id })),
      },
      guardrailConfig: { findUnique: async () => ({ rulesJson: ALL_OFF, productionSafetyMode: false }) },
      exposureConfig: { findUnique: async () => null },
      backupSchedule: { count: async () => 0 },
      auditLog: { create: async ({ data }: { data: unknown }) => data },
      emailConfig: { findUnique: async () => null },
      registryConfig: { findUnique: async () => null },
    },
    hub: {
      liveInventory: () => ({
        services: [...live.values()].map((s) => ({
          id: `id-${s.name}`, name: s.name, image: s.image, mode: 'replicated', desiredReplicas: 1, runningReplicas: 1,
          createdAt: 0, updatedAt: 0, labels: s.labels ?? {}, networks: [], env: Object.entries(s.env ?? {}).map(([k, v]) => `${k}=${v}`),
          ports: [], secrets: (s.secrets ?? []).map((r) => r.source), configs: [], mounts: [],
        })),
        containers: [],
      }),
      isOnline: (id: string) => NODES.find((n) => n.id === id)?.online ?? false,
      onlineNodeIds: () => NODES.filter((n) => n.online).map((n) => n.id),
      managerNode: () => 'n1',
      managerNodes: () => ['n1'],
      nodeInventory: () => [],
      nodeInfoFor: () => ({ availability: 'active' }),
      swarmStateFor: () => 'active',
      swarmNodeIdFor: (id: string) => NODES.find((n) => n.id === id)?.swarm,
      dispatch: async (_node: string, command: string, payload: Record<string, any>) => {
        if (command === 'service.deploy') {
          deployed.push(payload.spec);
          live.set(payload.spec.name, payload.spec);
        }
        if (command === 'secret.list') return { secrets: [] };
        if (command === 'secret.create') return { id: `id-${payload.name}`, name: payload.name };
        if (command === 'volume.list') return { volumes: [] };
        return {};
      },
    },
  } as unknown as OrgContext;
  return { ctx, deployed };
}

const compose = (plan: { steps: Array<{ kind: string; detail: Record<string, string> }> }) => plan.steps.find((s) => s.kind === 'stack.deploy')!;

describe('blueprints: pin a template deploy to a server (params.node)', () => {
  it('the plan renders node.id==<swarm id> and names the server', async () => {
    const { ctx } = fakeCtx();
    const plan = await planBlueprint(ctx, { id: 'ghost', params: { name: 'blog', size: 'm', options: {}, node: 'n2' } });
    expect(plan.node).toEqual({ id: 'n2', name: 'wkr-2', constraint: 'node.id==swarm-2' });
    expect(compose(plan).detail.placement).toBe('node.id==swarm-2');
  });

  it('no pin means no constraint and no server named', async () => {
    const { ctx } = fakeCtx();
    const plan = await planBlueprint(ctx, { id: 'ghost', params: { name: 'blog', size: 'm', options: {} } });
    expect(plan.node).toBeUndefined();
    expect(compose(plan).detail.placement).toBeUndefined();
  });

  it('refuses a server that is not in the org, or not Ready, in plain words', async () => {
    const { ctx } = fakeCtx();
    const p = (node: string) => planBlueprint(ctx, { id: 'ghost', params: { name: 'blog', size: 'm', options: {}, node } });
    await expect(p('n9')).rejects.toThrow('There\'s no server "n9" here. Pick another server, or Automatic.');
    await expect(p('n3')).rejects.toThrow('wkr-3 is offline, so nothing can be placed on it. Pick another server, or Automatic.');
    const { ctx: c2, deployed } = fakeCtx();
    await expect(deployBlueprint(c2, { id: 'ghost', params: { name: 'blog', size: 'm', options: {}, node: 'n9' } })).rejects.toThrow(/no server/);
    expect(deployed).toEqual([]);
  });

  it('a pinned deploy puts every service it creates on that server, and says so', async () => {
    const { ctx, deployed } = fakeCtx();
    const r = await deployBlueprint(ctx, { id: 'ghost', params: { name: 'blog', size: 'm', options: {}, node: 'n2' } });
    expect(r.node).toEqual({ id: 'n2', name: 'wkr-2', constraint: 'node.id==swarm-2' });
    const apps = deployed.filter((s) => s.name.startsWith('blog_'));
    expect(apps.map((s) => s.name).sort()).toEqual(['blog_ghost', 'blog_mysql']);
    for (const s of apps) expect(s.placement?.constraints).toEqual(['node.id==swarm-2']);
  });

  it('secrets and after-it’s-live steps come back apart: ghost has nothing to save once', async () => {
    const { ctx } = fakeCtx();
    const r = await deployBlueprint(ctx, { id: 'ghost', params: { name: 'blog', size: 'm', options: {} } });
    expect(r.notes).toEqual([]);
    expect(r.afterLive?.[0]).toBe('Open the app URL/ghost to create the owner account.');
  });
});

describe('pinComposeToNode (pure)', () => {
  it('replaces any node pin, keeps other constraints, and pins services that had none', () => {
    const src = 'services:\n  db:\n    image: mysql:8\n    deploy:\n      placement:\n        constraints: ["node.id==old", "node.labels.disk==ssd"]\n  web:\n    image: ghost:6\n    environment:\n      A: "$$HOME"\n';
    const out = parseYaml(pinComposeToNode(src, 'swarm-2')) as { services: Record<string, any> };
    expect(out.services.db.deploy.placement.constraints).toEqual(['node.labels.disk==ssd', 'node.id==swarm-2']);
    expect(out.services.web.deploy.placement.constraints).toEqual(['node.id==swarm-2']);
    expect(out.services.web.environment.A).toBe('$$HOME');
  });
});
