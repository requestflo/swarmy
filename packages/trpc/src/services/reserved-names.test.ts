import { describe, expect, it } from 'bun:test';
import { parse as parseYaml } from 'yaml';
import { networkIsolationViolations } from '@swarmy/core';
import { findAppTemplate } from '@swarmy/templates';
import { enforceAdmission } from './admission-gate';
import { isSystemOwned } from './system-service-deploy';
import { planComposeStack } from './stack.service';
import { createService } from './service.service';
import { compileServices } from './apps/compile';
import { compileTemplate } from './blueprints/from-app-config';

/**
 * The system-deploy gate (1a9bc99) treats `swarmy-*` / `swarmy_*` services as
 * swarmy's own. That's safe only if no user deploy path can create one: every
 * path must hit the name reservation (the network wall, which no override
 * lifts) before anything reaches the swarm.
 */
const wallRefuses = (specs: Array<{ name: string }>) =>
  networkIsolationViolations(specs).some((v) => v.rule === 'platform.reserved-name');

const noCtx = {} as never; // the wall runs before anything reads ctx

describe('reserved swarmy-* names on every user deploy path', () => {
  it('compose (stacks.deployFromCompose, REST POST /stacks): a swarmy-* stack yields refused names', async () => {
    for (const stack of ['swarmy-shop', 'swarmy_shop', 'swarmy']) {
      const plan = planComposeStack('services:\n  web:\n    image: nginx:1\n', stack);
      expect(plan.specs.every((s) => isSystemOwned(s))).toBe(true); // what the gate would think…
      expect(wallRefuses(plan.specs)).toBe(true); // …so the wall refuses it first
      await expect(
        enforceAdmission(noCtx, { kind: 'stack.deploy', orgId: 'o', stackName: stack, specs: plan.specs }, { targetType: 'stack', targetId: stack }),
      ).rejects.toThrow(/reserved for swarmy/);
    }
  });

  it('git apps (swarmy.yaml app: swarmy-x → one compose deploy)', async () => {
    const { parseAppConfig, toDesired } = await import('@swarmy/app-config');
    const res = parseAppConfig('version: 1\napp: swarmy-x\nservices:\n  web:\n    image: nginx:1.27\n    port: 80\n');
    const compose = compileServices(toDesired(res.config!), { web: 'nginx:1.27' }).composeSource;
    const plan = planComposeStack(compose, 'swarmy-x');
    expect(wallRefuses(plan.specs)).toBe(true);
    await expect(
      enforceAdmission(noCtx, { kind: 'stack.deploy', orgId: 'o', stackName: 'swarmy-x', specs: plan.specs }, { targetType: 'stack', targetId: 'swarmy-x' }),
    ).rejects.toThrow(/reserved for swarmy/);
  });

  it('templates (blueprints.deploy name: swarmy-x → one compose deploy)', () => {
    const { steps } = compileTemplate(findAppTemplate('bullmq-worker')!, { name: 'swarmy-x', size: 'm', options: {} } as never);
    const deploy = (steps as Array<{ kind: string; payload: { composeSource?: string } }>).find((s) => s.kind === 'stack.deploy')!;
    expect(parseYaml(deploy.payload.composeSource!)).toBeTruthy();
    expect(wallRefuses(planComposeStack(deploy.payload.composeSource!, 'swarmy-x').specs)).toBe(true);
  });

  it('image form (services.create, REST POST /services): refused before anything is dispatched', async () => {
    const dispatched: string[] = [];
    const ctx = {
      activeOrgId: 'o',
      user: { id: 'u' },
      membership: { role: 'owner', orgId: 'o' },
      db: {},
      hub: {
        liveInventory: () => ({ services: [], containers: [] }),
        isOnline: () => true,
        managerNode: () => 'n1',
        dispatch: async (_n: string, cmd: string) => {
          dispatched.push(cmd);
          return {};
        },
      },
    } as never;
    for (const name of ['swarmy-cache', 'swarmy_web']) {
      await expect(
        createService(ctx, { name, image: 'nginx:1', replicas: 1, command: [], env: [], ports: [], volumes: [], networks: [], constraints: [] }),
      ).rejects.toThrow(/reserved for swarmy/);
    }
    expect(dispatched.filter((c) => c === 'service.deploy')).toEqual([]);
  });

  it('a user app with an ordinary name is never system-owned', () => {
    const plan = planComposeStack('services:\n  swarmy:\n    image: nginx:1\n', 'shop');
    expect(plan.specs.map((s) => s.name)).toEqual(['shop_swarmy']);
    expect(plan.specs.some((s) => isSystemOwned(s))).toBe(false);
    expect(wallRefuses(plan.specs)).toBe(false);
  });
});
