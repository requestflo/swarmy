import { describe, expect, it } from 'bun:test';
import {
  SECRET_FAMILY_LABEL,
  SECRET_ORG_LABEL,
  SECRET_OWNER_BLUEPRINT_LABEL,
  SECRET_OWNER_STACK_LABEL,
  SECRET_VERSION_LABEL,
} from '@swarmy/core';
import type { ServiceSpec, SwarmResourceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { stacks } from './apps.repo';
import { deployBlueprint } from './blueprints.service';
import { ensureBlueprintSecretFamily, familyOwner } from './secret-owner.service';
import { removeStack } from './stack.service';

/**
 * QA-078: deleting a blueprint's stack left its generated secret family
 * behind, so redeploying the same name failed at "Generate secret" with
 * "family already exists". Stack delete now removes the families the
 * blueprint generated for it (owner label, never by name), and a redeploy of
 * the same stack + blueprint adopts a leftover one.
 */

const ALL_OFF = [
  'noLatestTagInProd',
  'minDbReplicasProd',
  'requireBackupPolicy',
  'requireHealthcheck',
  'requireResourceLimits',
  'requireSignedImagesProd',
  'noPrivilegedContainers',
  'noHostPortsProd',
].map((id) => ({ id, enabled: false, severity: 'block' }));

function secret(name: string, labels: Record<string, string>): SwarmResourceInfo {
  return { id: `id-${name}`, name, createdAt: 0, labels };
}

function owned(family: string, version: number, stack: string, blueprint: string): SwarmResourceInfo {
  return secret(`${family}__v${version}`, {
    [SECRET_FAMILY_LABEL]: family,
    [SECRET_VERSION_LABEL]: String(version),
    [SECRET_ORG_LABEL]: 'org1',
    [SECRET_OWNER_STACK_LABEL]: stack,
    [SECRET_OWNER_BLUEPRINT_LABEL]: blueprint,
  });
}

function fakeCtx(seed: { secrets?: SwarmResourceInfo[]; services?: ServiceSpec[] } = {}) {
  const dispatched: { command: string; payload: Record<string, any> }[] = [];
  const audits: Array<{ action: string; targetId: string | null; metadata: any }> = [];
  const secrets = new Map((seed.secrets ?? []).map((s) => [s.name, s]));
  const live = new Map((seed.services ?? []).map((s) => [s.name, s]));
  const ctx = {
    activeOrgId: 'org1',
    user: { id: 'user1' },
    membership: { role: 'admin', orgId: 'org1' },
    db: {
      guardrailConfig: { findUnique: async () => ({ rulesJson: ALL_OFF, productionSafetyMode: false }) },
      exposureConfig: { findUnique: async () => null },
      backupSchedule: { count: async () => 0 },
      auditLog: { create: async ({ data }: { data: any }) => (audits.push(data), data) },
      emailConfig: { findUnique: async () => null },
      registryConfig: { findUnique: async () => null },
    },
    hub: {
      liveInventory: () => ({
        services: [...live.values()].map((s) => ({
          id: `id-${s.name}`,
          name: s.name,
          image: s.image,
          mode: 'replicated',
          desiredReplicas: 1,
          runningReplicas: 1,
          createdAt: 0,
          updatedAt: 0,
          labels: s.labels ?? {},
          networks: [],
          env: Object.entries(s.env ?? {}).map(([k, v]) => `${k}=${v}`),
          ports: [],
          secrets: (s.secrets ?? []).map((r) => r.source),
          configs: [],
        })),
        containers: [],
      }),
      isOnline: () => true,
      onlineNodeIds: () => ['node1'],
      managerNode: () => 'node1',
      nodeInventory: () => [],
      dispatch: async (_node: string, command: string, payload: Record<string, any>) => {
        dispatched.push({ command, payload });
        switch (command) {
          case 'service.deploy':
            live.set(payload.spec.name, payload.spec);
            return {};
          case 'service.remove':
            live.delete(payload.service);
            return {};
          case 'secret.list':
            return { secrets: [...secrets.values()] };
          case 'secret.create':
            secrets.set(payload.name, secret(payload.name, payload.labels));
            return { id: `id-${payload.name}`, name: payload.name };
          case 'secret.remove':
            secrets.delete(payload.name);
            return {};
          default:
            return {};
        }
      },
    },
  } as unknown as OrgContext;
  return { ctx, dispatched, audits, secrets, live };
}

const spec = (name: string, stack: string, secretNames: string[]): ServiceSpec =>
  ({
    name,
    image: 'img:1',
    labels: { 'com.docker.stack.namespace': stack },
    secrets: secretNames.map((source) => ({ source })),
  }) as ServiceSpec;

describe('stack delete removes the secrets its blueprint generated (QA-078)', () => {
  it('ghost: deploy → delete → deploy the same name succeeds (fresh v1, no "already exists")', async () => {
    const w = fakeCtx();
    const first = await deployBlueprint(w.ctx, { id: 'ghost', params: { name: 'blog', size: 'm', options: {} } });
    expect(first.ok).toBe(true);
    const created = [...w.secrets.values()].find((s) => s.labels[SECRET_FAMILY_LABEL] === 'blog-db-password')!;
    expect(created.labels).toMatchObject({ [SECRET_OWNER_STACK_LABEL]: 'blog', [SECRET_OWNER_BLUEPRINT_LABEL]: 'ghost' });

    const row = await stacks(w.ctx, 'org1').findFirst({ where: { orgId: 'org1', name: 'blog' }, select: { id: true } });
    await removeStack(w.ctx, row!.id);
    expect([...w.secrets.keys()].filter((n) => n.startsWith('blog-db-password'))).toEqual([]);
    expect(w.audits).toContainEqual(
      expect.objectContaining({
        action: 'secrets.delete',
        targetId: 'blog-db-password',
        metadata: expect.objectContaining({ reason: 'stack.remove', stack: 'blog', blueprint: 'ghost' }),
      }),
    );

    const again = await deployBlueprint(w.ctx, { id: 'ghost', params: { name: 'blog', size: 'm', options: {} } });
    expect(again.steps.filter((s) => s.status !== 'succeeded')).toEqual([]);
    expect(again.ok).toBe(true);
  });

  it('meilisearch-app: its credential-env secrets are owner-labelled too, so delete → redeploy works', async () => {
    const w = fakeCtx();
    const first = await deployBlueprint(w.ctx, { id: 'meilisearch-app', params: { name: 'srch', size: 'm', options: {} } });
    expect(first.steps.filter((s) => s.status !== 'succeeded')).toEqual([]);
    const families = [...w.secrets.values()].map((s) => s.labels);
    expect(families.length).toBeGreaterThan(1);
    for (const l of families) expect(l).toMatchObject({ [SECRET_OWNER_STACK_LABEL]: 'srch', [SECRET_OWNER_BLUEPRINT_LABEL]: 'meilisearch-app' });
    const row = await stacks(w.ctx, 'org1').findFirst({ where: { orgId: 'org1', name: 'srch' }, select: { id: true } });
    await removeStack(w.ctx, row!.id);
    expect(w.secrets.size).toBe(0);
    const again = await deployBlueprint(w.ctx, { id: 'meilisearch-app', params: { name: 'srch', size: 'm', options: {} } });
    expect(again.steps.filter((s) => s.status !== 'succeeded')).toEqual([]);
  });

  it('keeps a family another stack still mounts, and never touches one without the owner label', async () => {
    const w = fakeCtx({
      secrets: [
        owned('blog-db-password', 1, 'blog', 'ghost'),
        owned('blog-shared', 1, 'blog', 'ghost'),
        // Same name pattern, created by hand (no owner label): not the stack's.
        secret('blog-manual__v1', { [SECRET_FAMILY_LABEL]: 'blog-manual', [SECRET_VERSION_LABEL]: '1', [SECRET_ORG_LABEL]: 'org1' }),
        // Owned by a different stack.
        owned('blogx-db-password', 1, 'blogx', 'ghost'),
      ],
      services: [
        spec('blog_mysql', 'blog', ['blog-db-password__v1', 'blog-shared__v1']),
        spec('other_app', 'other', ['blog-shared__v1']),
      ],
    });
    const row = await stacks(w.ctx, 'org1').create({
      data: { orgId: 'org1', name: 'blog', composeSource: 'services:\n  mysql:\n    image: mysql:8.4.7\n' },
    });
    await removeStack(w.ctx, row.id);
    expect([...w.secrets.keys()].sort()).toEqual(['blog-manual__v1', 'blog-shared__v1', 'blogx-db-password__v1']);
    expect(w.audits.filter((a) => a.action === 'secrets.delete').map((a) => a.targetId)).toEqual(['blog-db-password']);
  });
});

describe('ensureBlueprintSecretFamily — a redeploy adopts its own leftover (QA-078)', () => {
  const owner = { stack: 'blog', blueprint: 'ghost' };
  const gen = () => 'fresh-value';

  it('absent → creates v1 with the owner labels', async () => {
    const w = fakeCtx();
    const r = await ensureBlueprintSecretFamily(w.ctx, { family: 'blog-db-password', owner, generate: gen, needValue: false });
    expect(r).toEqual({ outcome: 'created', name: 'blog-db-password__v1', value: 'fresh-value' });
    expect(familyOwner([...w.secrets.values()], 'org1', 'blog-db-password')).toEqual(owner);
  });

  it('owned by this stack + blueprint and unattached → adopted (value kept), or rotated when the plan needs the value', async () => {
    const w = fakeCtx({ secrets: [owned('blog-db-password', 1, 'blog', 'ghost')] });
    const adopted = await ensureBlueprintSecretFamily(w.ctx, { family: 'blog-db-password', owner, generate: gen, needValue: false });
    expect(adopted).toEqual({ outcome: 'adopted', name: 'blog-db-password__v1' });
    expect(w.dispatched.some((d) => d.command === 'secret.create')).toBe(false);

    const rotated = await ensureBlueprintSecretFamily(w.ctx, { family: 'blog-db-password', owner, generate: gen, needValue: true });
    expect(rotated).toEqual({ outcome: 'rotated', name: 'blog-db-password__v2', value: 'fresh-value' });
    expect(familyOwner([...w.secrets.values()], 'org1', 'blog-db-password')).toEqual(owner);
  });

  it('owned by someone else, unlabelled, or still attached → refused with a clear reason', async () => {
    const other = fakeCtx({ secrets: [owned('blog-db-password', 1, 'blog', 'wordpress')] });
    await expect(
      ensureBlueprintSecretFamily(other.ctx, { family: 'blog-db-password', owner, generate: gen, needValue: false }),
    ).rejects.toThrow(/already exists and was not generated by the ghost blueprint for stack "blog"/);

    const manual = fakeCtx({
      secrets: [secret('blog-db-password__v1', { [SECRET_FAMILY_LABEL]: 'blog-db-password', [SECRET_VERSION_LABEL]: '1', [SECRET_ORG_LABEL]: 'org1' })],
    });
    await expect(
      ensureBlueprintSecretFamily(manual.ctx, { family: 'blog-db-password', owner, generate: gen, needValue: false }),
    ).rejects.toThrow(/already exists and was not generated/);

    const inUse = fakeCtx({
      secrets: [owned('blog-db-password', 1, 'blog', 'ghost')],
      services: [spec('blog_mysql', 'blog', ['blog-db-password__v1'])],
    });
    await expect(
      ensureBlueprintSecretFamily(inUse.ctx, { family: 'blog-db-password', owner, generate: gen, needValue: false }),
    ).rejects.toThrow(/still used by blog_mysql/);
  });
});
