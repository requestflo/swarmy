import type { CreateServiceInput, UpdateServiceInput } from '@swarmy/core';
import type { ServiceSpec } from '@swarmy/core/protocol';
import type { ServiceDetail, ServiceStatusView, ServiceSummary } from '@swarmy/core/views';
import type { OrgContext } from '../context';
import { mapDispatchError, notFound } from '../errors';
import { failDeployment, resolveManagerNode } from './dispatch.service';
import { enqueueEvent } from './webhooks-out.service';

interface ServiceRow {
  id: string;
  name: string;
  image: string;
  replicas: number;
  status: string;
  nodeId: string | null;
  stackId: string | null;
  ingressEnabled: boolean;
  swarmServiceId: string | null;
  env: unknown;
  ports: unknown;
  volumes: unknown;
  networks: unknown;
  constraints: unknown;
  command: unknown;
  createdAt: Date;
  updatedAt: Date;
}

function envArrayToRecord(env: { key: string; value: string }[]): Record<string, string> {
  return Object.fromEntries(env.map((e) => [e.key, e.value]));
}

function recordToEnvArray(env: Record<string, string>): { key: string; value: string }[] {
  return Object.entries(env).map(([key, value]) => ({ key, value }));
}

function statusView(db: string): ServiceStatusView {
  const map: Record<string, ServiceStatusView> = {
    PENDING: 'pending',
    DEPLOYING: 'deploying',
    RUNNING: 'running',
    DEGRADED: 'degraded',
    STOPPED: 'stopped',
    FAILED: 'failed',
    REMOVING: 'removing',
  };
  return map[db] ?? 'pending';
}

function buildServiceSpec(row: {
  name: string;
  image: string;
  replicas: number;
  env: Record<string, string>;
  command: string[];
  ports: { target: number; published?: number; protocol: string; mode: string }[];
  volumes: { type: string; source?: string; target: string; readOnly?: boolean }[];
  networks: string[];
  constraints: string[];
}): ServiceSpec {
  return {
    name: row.name,
    image: row.image,
    mode: { replicated: { replicas: row.replicas } },
    env: row.env,
    command: row.command.length ? row.command : undefined,
    ports: row.ports.map((p) => ({
      target: p.target,
      published: p.published,
      protocol: p.protocol === 'udp' ? 'udp' : 'tcp',
      mode: p.mode === 'host' ? 'host' : 'ingress',
    })),
    mounts: row.volumes.map((v) => ({
      type: v.type === 'bind' ? 'bind' : v.type === 'tmpfs' ? 'tmpfs' : 'volume',
      source: v.source,
      target: v.target,
      readOnly: v.readOnly,
    })),
    networks: row.networks,
  };
}

function toSummary(ctx: OrgContext, row: ServiceRow): ServiceSummary {
  const live = ctx.hub.latestServiceState(ctx.activeOrgId).find((s) => s.serviceName === row.name);
  return {
    id: row.id,
    name: row.name,
    image: row.image,
    status: statusView(row.status),
    replicas: { desired: row.replicas, running: live?.runningReplicas ?? 0 },
    ingressEnabled: row.ingressEnabled,
    nodeId: row.nodeId,
    stackId: row.stackId,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listServices(
  ctx: OrgContext,
  filter?: { nodeId?: string; stackId?: string; status?: string; search?: string },
): Promise<ServiceSummary[]> {
  const rows = (await ctx.db.service.findMany({
    where: {
      orgId: ctx.activeOrgId,
      nodeId: filter?.nodeId,
      stackId: filter?.stackId,
      name: filter?.search ? { contains: filter.search, mode: 'insensitive' } : undefined,
    },
    orderBy: { createdAt: 'desc' },
  })) as unknown as ServiceRow[];
  return rows.map((r) => toSummary(ctx, r));
}

export async function getServiceDetail(ctx: OrgContext, id: string): Promise<ServiceDetail> {
  const row = (await ctx.db.service.findFirst({
    where: { id, orgId: ctx.activeOrgId },
  })) as unknown as ServiceRow | null;
  if (!row) throw notFound('service', id);
  const env = (row.env as Record<string, string>) ?? {};
  return {
    ...toSummary(ctx, row),
    env,
    ports: (row.ports as ServiceDetail['ports']) ?? [],
    volumes: (row.volumes as ServiceDetail['volumes']) ?? [],
    networks: (row.networks as string[]) ?? [],
    constraints: (row.constraints as string[]) ?? [],
    swarmServiceId: row.swarmServiceId,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function createService(
  ctx: OrgContext,
  input: CreateServiceInput,
): Promise<{ id: string; deploymentId: string }> {
  const node = await resolveManagerNode(ctx, input.nodeId);
  const svc = await ctx.db.service.create({
    data: {
      orgId: ctx.activeOrgId,
      name: input.name,
      image: input.image,
      replicas: input.replicas,
      command: input.command,
      env: envArrayToRecord(input.env),
      ports: input.ports,
      volumes: input.volumes,
      networks: input.networks,
      constraints: input.constraints,
      nodeId: input.nodeId ?? null,
      ingressEnabled: input.ingress?.enabled ?? false,
      status: 'DEPLOYING',
    },
  });
  const deployment = await ctx.db.deployment.create({
    data: {
      orgId: ctx.activeOrgId,
      targetType: 'SERVICE',
      serviceId: svc.id,
      kind: 'create',
      phase: 'QUEUED',
      desired: input.replicas,
      triggeredById: ctx.user.id,
    },
  });
  const spec = buildServiceSpec({
    name: input.name,
    image: input.image,
    replicas: input.replicas,
    env: envArrayToRecord(input.env),
    command: input.command,
    ports: input.ports,
    volumes: input.volumes,
    networks: input.networks,
    constraints: input.constraints,
  });
  try {
    await ctx.hub.dispatch(node.id, 'service.deploy', { spec, pullPolicy: 'always' });
  } catch (e) {
    await failDeployment(ctx, deployment.id, e);
    throw mapDispatchError(e);
  }
  // Outbound webhook: fan a `service.deployed` event out to subscribed endpoints.
  await enqueueEvent(ctx.db, ctx.activeOrgId, 'service.deployed', {
    serviceId: svc.id,
    name: input.name,
    image: input.image,
    deploymentId: deployment.id,
  }).catch(() => undefined); // best-effort; never blocks the deploy
  return { id: svc.id, deploymentId: deployment.id };
}

export async function updateService(
  ctx: OrgContext,
  input: UpdateServiceInput,
): Promise<{ id: string; deploymentId: string }> {
  const existing = (await ctx.db.service.findFirst({
    where: { id: input.id, orgId: ctx.activeOrgId },
  })) as unknown as ServiceRow | null;
  if (!existing) throw notFound('service', input.id);
  const node = await resolveManagerNode(ctx, existing.nodeId);

  const merged = {
    name: input.name ?? existing.name,
    image: input.image ?? existing.image,
    replicas: input.replicas ?? existing.replicas,
    env: input.env ? envArrayToRecord(input.env) : ((existing.env as Record<string, string>) ?? {}),
    command: input.command ?? ((existing.command as string[]) ?? []),
    ports: input.ports ?? ((existing.ports as ServiceDetail['ports']) ?? []),
    volumes: input.volumes ?? ((existing.volumes as ServiceDetail['volumes']) ?? []),
    networks: input.networks ?? ((existing.networks as string[]) ?? []),
    constraints: input.constraints ?? ((existing.constraints as string[]) ?? []),
  };

  await ctx.db.service.update({
    where: { id: input.id },
    data: {
      image: merged.image,
      replicas: merged.replicas,
      env: merged.env,
      command: merged.command,
      ports: merged.ports,
      volumes: merged.volumes,
      networks: merged.networks,
      constraints: merged.constraints,
      ingressEnabled: input.ingress?.enabled ?? existing.ingressEnabled,
      status: 'DEPLOYING',
    },
  });
  const deployment = await ctx.db.deployment.create({
    data: {
      orgId: ctx.activeOrgId,
      targetType: 'SERVICE',
      serviceId: input.id,
      kind: 'update',
      phase: 'QUEUED',
      desired: merged.replicas,
      triggeredById: ctx.user.id,
    },
  });
  try {
    await ctx.hub.dispatch(node.id, 'service.deploy', {
      spec: buildServiceSpec(merged),
      pullPolicy: 'always',
    });
  } catch (e) {
    await failDeployment(ctx, deployment.id, e);
    throw mapDispatchError(e);
  }
  return { id: input.id, deploymentId: deployment.id };
}

export async function scaleService(
  ctx: OrgContext,
  input: { id: string; replicas: number },
): Promise<{ id: string; deploymentId: string }> {
  const svc = (await ctx.db.service.findFirst({
    where: { id: input.id, orgId: ctx.activeOrgId },
    select: { id: true, name: true, nodeId: true },
  })) as { id: string; name: string; nodeId: string | null } | null;
  if (!svc) throw notFound('service', input.id);
  const node = await resolveManagerNode(ctx, svc.nodeId);
  const deployment = await ctx.db.deployment.create({
    data: {
      orgId: ctx.activeOrgId,
      targetType: 'SERVICE',
      serviceId: svc.id,
      kind: 'scale',
      phase: 'QUEUED',
      desired: input.replicas,
      triggeredById: ctx.user.id,
    },
  });
  try {
    await ctx.hub.dispatch(node.id, 'service.scale', { service: svc.name, replicas: input.replicas });
  } catch (e) {
    await failDeployment(ctx, deployment.id, e);
    throw mapDispatchError(e);
  }
  await ctx.db.service.update({ where: { id: svc.id }, data: { replicas: input.replicas } });
  return { id: svc.id, deploymentId: deployment.id };
}

export async function restartService(
  ctx: OrgContext,
  id: string,
): Promise<{ id: string; deploymentId: string }> {
  const svc = (await ctx.db.service.findFirst({
    where: { id, orgId: ctx.activeOrgId },
    select: { id: true, name: true, nodeId: true },
  })) as { id: string; name: string; nodeId: string | null } | null;
  if (!svc) throw notFound('service', id);
  const node = await resolveManagerNode(ctx, svc.nodeId);
  const deployment = await ctx.db.deployment.create({
    data: {
      orgId: ctx.activeOrgId,
      targetType: 'SERVICE',
      serviceId: svc.id,
      kind: 'restart',
      phase: 'QUEUED',
      triggeredById: ctx.user.id,
    },
  });
  try {
    await ctx.hub.dispatch(node.id, 'service.restart', { service: svc.name });
  } catch (e) {
    await failDeployment(ctx, deployment.id, e);
    throw mapDispatchError(e);
  }
  return { id: svc.id, deploymentId: deployment.id };
}

export async function removeService(
  ctx: OrgContext,
  id: string,
): Promise<{ id: string; removed: true }> {
  const svc = (await ctx.db.service.findFirst({
    where: { id, orgId: ctx.activeOrgId },
    select: { id: true, name: true, nodeId: true },
  })) as { id: string; name: string; nodeId: string | null } | null;
  if (!svc) throw notFound('service', id);
  const node = await resolveManagerNode(ctx, svc.nodeId).catch(() => null);
  if (node) {
    await ctx.hub.dispatch(node.id, 'service.remove', { service: svc.name }).catch(() => undefined);
  }
  await ctx.db.service.delete({ where: { id: svc.id } });
  return { id: svc.id, removed: true };
}

export { recordToEnvArray };
