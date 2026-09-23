import { describe, expect, it } from 'bun:test';
import { TRPCError } from '@trpc/server';
import type { CreateServiceInput } from '@swarmy/core';
import type { OrgContext } from '../context';
import { createService, updateService } from './service.service';

/**
 * Regression gate for issues/guardrails-bypassed-by-quick-deploy-service-create.md:
 * "Ship a service" (`createService`) must run the admission spine exactly like
 * `deployFromCompose` — refuse a `:latest` image into an armed production
 * stack, and write a `service.deploy` audit row when the deploy goes through.
 */

interface AuditRow {
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
}

/** Only the `:latest` rule armed at block — every other guardrail off. */
const LATEST_ONLY = [
  'noLatestTagInProd',
  'minDbReplicasProd',
  'requireBackupPolicy',
  'requireHealthcheck',
  'requireResourceLimits',
  'requireSignedImagesProd',
  'noPrivilegedContainers',
  'noHostPortsProd',
].map((id) => ({ id, enabled: id === 'noLatestTagInProd', severity: 'block' }));

function fakeCtx(opts: {
  safetyMode: boolean;
  rulesJson?: unknown;
  role?: 'owner' | 'admin' | 'member';
}) {
  const audit: AuditRow[] = [];
  const dispatched: { node: string; command: string; payload: unknown }[] = [];
  const ctx = {
    activeOrgId: 'org1',
    user: { id: 'user1' },
    membership: { role: opts.role ?? 'admin', orgId: 'org1' },
    db: {
      guardrailConfig: {
        findUnique: async () => ({
          rulesJson: opts.rulesJson ?? LATEST_ONLY,
          productionSafetyMode: opts.safetyMode,
        }),
      },
      exposureConfig: { findUnique: async () => null },
      registryConfig: { findUnique: async () => null },
      backupSchedule: { count: async () => 0 },
      auditLog: {
        create: async ({ data }: { data: AuditRow }) => {
          audit.push(data);
          return data;
        },
      },
    },
    hub: {
      // The `shop` stack is production: one live service carries swarmy.env=production.
      liveInventory: () => ({
        services: [
          {
            id: 'svc-api',
            name: 'shop_api',
            image: 'ghcr.io/acme/api:1.2.3',
            mode: 'replicated',
            desiredReplicas: 1,
            runningReplicas: 1,
            labels: { 'com.docker.stack.namespace': 'shop', 'swarmy.env': 'production' },
          },
        ],
        containers: [],
      }),
      isOnline: () => true,
      managerNode: () => 'node1',
      swarmNodeIdFor: (id: string) => (id === 'worker1' ? 'swarm-worker-1' : undefined),
      dispatch: async (node: string, command: string, payload: unknown) => {
        dispatched.push({ node, command, payload });
        // updateService patches the FULL live spec — answer the inspect it reads.
        if (command === 'service.inspect') {
          return {
            inspect: {
              Spec: {
                Name: 'shop_api',
                Labels: { 'com.docker.stack.namespace': 'shop', 'swarmy.env': 'production' },
                Mode: { Replicated: { Replicas: 1 } },
                TaskTemplate: { ContainerSpec: { Image: 'ghcr.io/acme/api:1.2.3' } },
              },
            },
          };
        }
        return {};
      },
    },
  } as unknown as OrgContext;
  return { ctx, audit, dispatched };
}

function input(image: string, extra: Partial<CreateServiceInput> = {}): CreateServiceInput {
  return {
    name: 'web',
    image,
    replicas: 1,
    command: [],
    env: [],
    ports: [],
    volumes: [],
    networks: [],
    constraints: [],
    project: 'shop',
    ...extra,
  };
}

describe('createService admission', () => {
  it('refuses a :latest image into an armed production stack — nothing is dispatched', async () => {
    const { ctx, audit, dispatched } = fakeCtx({ safetyMode: true });
    let err: unknown;
    try {
      await createService(ctx, input('nginx:latest'));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe('PRECONDITION_FAILED');
    expect((err as TRPCError).message).toContain('guardrails/no-latest-tag-in-prod');
    expect(((err as TRPCError).cause as unknown as { swarmyCode: string }).swarmyCode).toBe(
      'POLICY_DENIED',
    );
    expect(dispatched).toHaveLength(0);
    // The refusal lands in the Recent-decisions feed; no success row is written.
    expect(audit.map((a) => a.action)).toEqual(['guardrails.deploy.blocked']);
  });

  it('a member cannot override a block; an admin override deploys and is audited', async () => {
    const member = fakeCtx({ safetyMode: true, role: 'member' });
    await expect(createService(member.ctx, input('nginx:latest', { override: true }))).rejects.toThrow(
      /requires an admin or owner/,
    );
    expect(member.dispatched).toHaveLength(0);

    const admin = fakeCtx({ safetyMode: true, role: 'admin' });
    await createService(admin.ctx, input('nginx:latest', { override: true }));
    expect(admin.dispatched.map((d) => d.command)).toEqual(['service.deploy']);
    expect(admin.audit.map((a) => a.action)).toEqual(['service.deploy.override', 'service.deploy']);
  });

  it('refuses under the individually-armed block rule too (safety mode off)', async () => {
    const { ctx, dispatched } = fakeCtx({ safetyMode: false });
    await expect(createService(ctx, input('nginx'))).rejects.toThrow(/guardrails\/no-latest-tag-in-prod/);
    expect(dispatched).toHaveLength(0);
  });

  it('writes a service.deploy audit entry on a compliant deploy', async () => {
    const { ctx, audit, dispatched } = fakeCtx({ safetyMode: false });
    const res = await createService(ctx, input('nginx:1.27.1'));
    expect(res.id).toBe('web');
    expect(dispatched.map((d) => d.command)).toEqual(['service.deploy']);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'service.deploy',
      targetType: 'service',
      targetId: 'web',
      metadata: { name: 'web', image: 'nginx:1.27.1', stack: 'shop', override: false },
    });
  });

  it(':latest outside production is not blocked when safety mode is off', async () => {
    const { ctx, dispatched } = fakeCtx({ safetyMode: false });
    await createService(ctx, input('nginx:latest', { project: 'scratch' }));
    expect(dispatched).toHaveLength(1);
  });
});

describe('updateService admission', () => {
  it('refuses re-pointing a production service at :latest', async () => {
    const { ctx, dispatched } = fakeCtx({ safetyMode: false });
    await expect(updateService(ctx, { id: 'svc-api', image: 'ghcr.io/acme/api:latest' })).rejects.toThrow(
      /guardrails\/no-latest-tag-in-prod/,
    );
    expect(dispatched.filter((d) => d.command === 'service.deploy')).toHaveLength(0);
  });

  it('keeps the live label set (swarmy.env survives) and audits the update', async () => {
    const { ctx, audit, dispatched } = fakeCtx({ safetyMode: false });
    await updateService(ctx, { id: 'svc-api', image: 'ghcr.io/acme/api:1.3.0' });
    const deploy = dispatched.find((d) => d.command === 'service.deploy');
    const spec = (deploy?.payload as { spec: { labels: Record<string, string> } }).spec;
    expect(spec.labels['swarmy.env']).toBe('production');
    expect(spec.labels['com.docker.stack.namespace']).toBe('shop');
    expect(audit[0]).toMatchObject({
      action: 'service.deploy',
      metadata: { image: 'ghcr.io/acme/api:1.3.0', previousImage: 'ghcr.io/acme/api:1.2.3', update: true },
    });
  });
});

describe('createService pinned to a node', () => {
  it('dispatches to the manager with a node.id constraint, never to the worker itself', async () => {
    const { ctx, dispatched } = fakeCtx({ safetyMode: false });
    await createService(ctx, input('nginx:1.27', { nodeId: 'worker1', project: 'other' }));
    const deploy = dispatched.find((d) => d.command === 'service.deploy');
    expect(deploy?.node).toBe('node1');
    const spec = (deploy?.payload as { spec: { placement?: { constraints?: string[] } } }).spec;
    expect(spec.placement?.constraints).toContain('node.id==swarm-worker-1');
  });
});
