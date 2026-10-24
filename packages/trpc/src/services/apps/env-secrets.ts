/**
 * Fill one secret slot of a dashboard environment (board Environments:
 * "create secret stripe-key for qa · secrets are never copied"). The value is
 * write-only: it rides straight into a NEW Docker secret family that belongs
 * to this environment alone — `<family>.<env>` — and is mounted where the app
 * already reads it (`/run/secrets/<family>`, or exported as its env var by
 * the secret-env shim). Setting it again rotates that family. Nothing is read
 * from, or written to, any other environment's secret. The secrets manager
 * audits create / rotate / attach (names and versions, never the value).
 */
import { buildInventory } from '@swarmy/core';
import type { OrgContext } from '../../context';
import { commandRejected, notFound } from '../../errors';
import { resolveManagerNode } from '../dispatch.service';
import {
  attachSecretToService,
  createSecretFamily,
  groupSecrets,
  listRawSecrets,
  parsePhysicalSecretName,
  rotateSecretFamily,
} from '../secretsMgr.service';
import { dashboardEnvironments } from './dashboard-envs';

export interface SetEnvironmentSecretInput {
  /** The dashboard environment's stack (`shop-qa`). */
  stack: string;
  /** The slot, by the name swarmy.yaml uses (`stripe-key`). */
  family: string;
  value: string;
}

export interface SetEnvironmentSecretResult {
  family: string;
  envFamily: string;
  version: number;
  /** Services now reading it. Never the value. */
  services: string[];
}

export interface EnvSecretOps {
  exists(ctx: OrgContext, family: string): Promise<boolean>;
  create(ctx: OrgContext, family: string, value: string, stack: string): Promise<{ version: number }>;
  rotate(ctx: OrgContext, family: string, value: string): Promise<{ version: number }>;
  attach(ctx: OrgContext, a: { family: string; service: string; target?: string; envName?: string; delivery?: 'env' }): Promise<void>;
  /** Swarm service names in the stack that already mount `family`. */
  mounted(ctx: OrgContext, stack: string, family: string): string[];
}

export const realEnvSecretOps: EnvSecretOps = {
  async exists(ctx, family) {
    const node = await resolveManagerNode(ctx);
    return groupSecrets(await listRawSecrets(ctx, node.id), ctx.activeOrgId).families.some((f) => f.family === family);
  },
  create: (ctx, family, value, stack) => createSecretFamily(ctx, { family, value, stack }),
  rotate: (ctx, family, value) => rotateSecretFamily(ctx, { family, value }),
  async attach(ctx, a) {
    await attachSecretToService(ctx, a);
  },
  mounted(ctx, stack, family) {
    const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
    return buildInventory(services, containers)
      .services.filter((s) => s.stack === stack && (s.secrets ?? []).some((n) => parsePhysicalSecretName(n)?.family === family))
      .map((s) => s.name);
  },
};

export async function setEnvironmentSecret(
  ctx: OrgContext,
  input: SetEnvironmentSecretInput,
  ops: EnvSecretOps = realEnvSecretOps,
): Promise<SetEnvironmentSecretResult> {
  if (!input.value) throw commandRejected('paste the secret’s value');
  const plan = await ctx.db.appPlan.findFirst({
    where: { orgId: ctx.activeOrgId, stack: input.stack, prNumber: 0 },
    orderBy: { createdAt: 'desc' },
    select: { repoId: true },
  });
  if (!plan) throw notFound('environment', input.stack);
  const env = (await dashboardEnvironments(ctx.db, plan.repoId)).find((e) => e.stack === input.stack);
  if (!env) throw commandRejected(`${input.stack} gets its secrets from swarmy.yaml, not from a slot`);
  const slot = env.marker.secretSlots.find((s) => s.family === input.family);
  if (!slot) throw notFound('secret slot', `${input.stack}/${input.family}`);

  const { version } = (await ops.exists(ctx, slot.envFamily))
    ? await ops.rotate(ctx, slot.envFamily, input.value)
    : await ops.create(ctx, slot.envFamily, input.value, input.stack);
  const already = new Set(ops.mounted(ctx, input.stack, slot.envFamily));
  const services: string[] = [];
  for (const c of slot.consumers) {
    const service = `${input.stack}_${c.service}`;
    services.push(service);
    if (already.has(service)) continue; // a rotation already moved it onto the new version
    await ops.attach(
      ctx,
      c.envName ? { family: slot.envFamily, service, envName: c.envName, delivery: 'env' } : { family: slot.envFamily, service, target: slot.family },
    );
  }
  return { family: slot.family, envFamily: slot.envFamily, version, services: [...new Set(services)] };
}
