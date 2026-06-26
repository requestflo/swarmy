import { parse as parseYaml } from 'yaml';
import type { ServiceSpec } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { mapDispatchError, notFound } from '../errors';
import { failDeployment, resolveManagerNode } from './dispatch.service';

export interface StackSummary {
  id: string;
  name: string;
  serviceCount: number;
  status: string;
  updatedAt: string;
}

export interface StackDetail extends StackSummary {
  composeSource: string;
  services: { id: string; name: string; image: string }[];
  createdAt: string;
}

interface ComposeService {
  image?: string;
  command?: string | string[];
  environment?: Record<string, string> | string[];
  ports?: string[];
  networks?: string[] | Record<string, unknown>;
  deploy?: { replicas?: number };
}

/** Parse a docker-compose document into normalized swarmy service specs. */
export function composeToSpecs(source: string): ServiceSpec[] {
  const doc = parseYaml(source) as { services?: Record<string, ComposeService> } | null;
  const services = doc?.services ?? {};
  return Object.entries(services).map(([name, svc]) => {
    const env: Record<string, string> = {};
    if (Array.isArray(svc.environment)) {
      for (const e of svc.environment) {
        const [k, ...rest] = e.split('=');
        if (k) env[k] = rest.join('=');
      }
    } else if (svc.environment) {
      Object.assign(env, svc.environment);
    }
    const ports = (svc.ports ?? []).map((p) => {
      const parts = String(p).split(':');
      const target = Number(parts[parts.length - 1]);
      const published = parts.length > 1 ? Number(parts[parts.length - 2]) : undefined;
      return { target, published, protocol: 'tcp' as const, mode: 'ingress' as const };
    });
    return {
      name,
      image: svc.image ?? '',
      mode: { replicated: { replicas: svc.deploy?.replicas ?? 1 } },
      env: Object.keys(env).length ? env : undefined,
      command: Array.isArray(svc.command) ? svc.command : svc.command ? [svc.command] : undefined,
      ports: ports.length ? ports : undefined,
      networks: Array.isArray(svc.networks) ? svc.networks : undefined,
    } satisfies ServiceSpec;
  });
}

export async function listStacks(ctx: OrgContext): Promise<StackSummary[]> {
  const rows = await ctx.db.stack.findMany({
    where: { orgId: ctx.activeOrgId },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { services: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    serviceCount: r._count.services,
    status: r.status.toLowerCase(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export async function getStack(ctx: OrgContext, id: string): Promise<StackDetail> {
  const row = await ctx.db.stack.findFirst({
    where: { id, orgId: ctx.activeOrgId },
    include: { services: { select: { id: true, name: true, image: true } } },
  });
  if (!row) throw notFound('stack', id);
  return {
    id: row.id,
    name: row.name,
    serviceCount: row.services.length,
    status: row.status.toLowerCase(),
    updatedAt: row.updatedAt.toISOString(),
    composeSource: row.composeSource,
    services: row.services,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function deployFromCompose(
  ctx: OrgContext,
  input: { name: string; composeSource: string },
): Promise<{ id: string; deploymentId: string }> {
  const specs = composeToSpecs(input.composeSource);
  const node = await resolveManagerNode(ctx);

  const stack = await ctx.db.stack.upsert({
    where: { orgId_name: { orgId: ctx.activeOrgId, name: input.name } },
    create: {
      orgId: ctx.activeOrgId,
      name: input.name,
      composeSource: input.composeSource,
      status: 'DEPLOYING',
    },
    update: { composeSource: input.composeSource, status: 'DEPLOYING' },
  });

  const deployment = await ctx.db.deployment.create({
    data: {
      orgId: ctx.activeOrgId,
      targetType: 'STACK',
      stackId: stack.id,
      kind: 'stack',
      phase: 'QUEUED',
      triggeredById: ctx.user.id,
    },
  });

  try {
    for (const spec of specs) {
      await ctx.db.service.upsert({
        where: { orgId_name: { orgId: ctx.activeOrgId, name: spec.name } },
        create: {
          orgId: ctx.activeOrgId,
          stackId: stack.id,
          name: spec.name,
          image: spec.image,
          replicas: spec.mode?.replicated?.replicas ?? 1,
          env: spec.env ?? {},
          status: 'DEPLOYING',
        },
        update: { image: spec.image, stackId: stack.id, status: 'DEPLOYING' },
      });
      await ctx.hub.dispatch(node.id, 'service.deploy', { spec, pullPolicy: 'always' });
    }
  } catch (e) {
    await failDeployment(ctx, deployment.id, e);
    await ctx.db.stack.update({ where: { id: stack.id }, data: { status: 'FAILED' } });
    throw mapDispatchError(e);
  }

  return { id: stack.id, deploymentId: deployment.id };
}

export async function redeployStack(
  ctx: OrgContext,
  input: { id: string; composeSource?: string },
): Promise<{ id: string; deploymentId: string }> {
  const stack = await ctx.db.stack.findFirst({
    where: { id: input.id, orgId: ctx.activeOrgId },
    select: { name: true, composeSource: true },
  });
  if (!stack) throw notFound('stack', input.id);
  return deployFromCompose(ctx, {
    name: stack.name,
    composeSource: input.composeSource ?? stack.composeSource,
  });
}

export async function removeStack(
  ctx: OrgContext,
  id: string,
): Promise<{ id: string; removed: true }> {
  const stack = await ctx.db.stack.findFirst({
    where: { id, orgId: ctx.activeOrgId },
    include: { services: { select: { name: true } } },
  });
  if (!stack) throw notFound('stack', id);
  const node = await resolveManagerNode(ctx).catch(() => null);
  if (node) {
    for (const svc of stack.services) {
      await ctx.hub.dispatch(node.id, 'service.remove', { service: svc.name }).catch(() => undefined);
    }
  }
  await ctx.db.stack.delete({ where: { id } });
  return { id, removed: true };
}
