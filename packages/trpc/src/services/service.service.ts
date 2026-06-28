import {
  buildInventory,
  SCALE_TO_ZERO_IDLE_LABEL,
  SCALE_TO_ZERO_LABEL,
  SCALE_TO_ZERO_TARGET_LABEL,
  type CreateServiceInput,
  type InvService,
  type InvServiceStatus,
  type UpdateServiceInput,
} from '@swarmy/core';
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
  project?: string;
}): ServiceSpec {
  return {
    name: row.name,
    image: row.image,
    mode: { replicated: { replicas: row.replicas } },
    labels: {
      'swarmy.managed': 'true',
      // Project = Docker stack namespace (native grouping read back by the inventory).
      ...(row.project ? { 'com.docker.stack.namespace': row.project } : {}),
    },
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

/** InvService status → the dashboard's ServiceStatusView (idle/stopped collapse). */
const INV_STATUS: Record<InvServiceStatus, ServiceStatusView> = {
  running: 'running',
  degraded: 'degraded',
  deploying: 'deploying',
  idle: 'stopped',
  stopped: 'stopped',
};

/** Resolve a service from the LIVE Docker inventory (by Docker id or name). No DB. */
function liveService(ctx: OrgContext, idOrName: string): InvService | undefined {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  const all = buildInventory(services, containers).services;
  return all.find((s) => s.id === idOrName) ?? all.find((s) => s.name === idOrName);
}

export function getServiceDetail(ctx: OrgContext, id: string): ServiceDetail {
  const s = liveService(ctx, id);
  if (!s) throw notFound('service', id);
  const env: Record<string, string> = {};
  for (const kv of s.env) {
    const i = kv.indexOf('=');
    env[i >= 0 ? kv.slice(0, i) : kv] = i >= 0 ? kv.slice(i + 1) : '';
  }
  return {
    id: s.id,
    name: s.name,
    image: s.image,
    status: INV_STATUS[s.status],
    replicas: s.replicas,
    ingressEnabled: s.labels['swarmy.ingress'] === 'true' || s.ports.length > 0,
    nodeId: null,
    stackId: s.stack === '(ungrouped)' ? null : s.stack,
    updatedAt: new Date().toISOString(),
    env,
    ports: s.ports.map((p) => ({ target: p.target, published: p.published, protocol: p.protocol, mode: 'ingress' })),
    volumes: [],
    networks: s.networks.map((n) => n.name),
    constraints: [],
    swarmServiceId: s.id,
    createdAt: new Date().toISOString(),
    scaleToZero: {
      enabled: s.scaleToZero,
      targetReplicas: Number(s.labels[SCALE_TO_ZERO_TARGET_LABEL]) || Math.max(1, s.replicas.desired || 1),
      idleSeconds: Number(s.labels[SCALE_TO_ZERO_IDLE_LABEL]) || 300,
    },
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
    project: input.project,
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
  const svc = liveService(ctx, input.id);
  if (!svc) throw notFound('service', input.id);
  const node = await resolveManagerNode(ctx);
  try {
    await ctx.hub.dispatch(node.id, 'service.scale', { service: svc.name, replicas: input.replicas });
  } catch (e) {
    throw mapDispatchError(e);
  }
  return { id: svc.id, deploymentId: '' };
}

export async function restartService(
  ctx: OrgContext,
  id: string,
): Promise<{ id: string; deploymentId: string }> {
  const svc = liveService(ctx, id);
  if (!svc) throw notFound('service', id);
  const node = await resolveManagerNode(ctx);
  try {
    await ctx.hub.dispatch(node.id, 'service.restart', { service: svc.name });
  } catch (e) {
    throw mapDispatchError(e);
  }
  return { id: svc.id, deploymentId: '' };
}

export async function removeService(
  ctx: OrgContext,
  id: string,
): Promise<{ id: string; removed: true }> {
  const svc = liveService(ctx, id);
  if (!svc) throw notFound('service', id);
  const node = await resolveManagerNode(ctx).catch(() => null);
  if (node) {
    await ctx.hub.dispatch(node.id, 'service.remove', { service: svc.name }).catch(() => undefined);
  }
  return { id: svc.id, removed: true };
}

/** Enable/disable scale-to-zero on a service (persisted as Docker labels). */
export async function setScaleToZero(
  ctx: OrgContext,
  input: { id: string; enabled: boolean; targetReplicas?: number; idleSeconds?: number },
): Promise<{ id: string; ok: true }> {
  const s = liveService(ctx, input.id);
  if (!s) throw notFound('service', input.id);
  const node = await resolveManagerNode(ctx);
  const payload = input.enabled
    ? {
        service: s.name,
        add: {
          [SCALE_TO_ZERO_LABEL]: 'true',
          [SCALE_TO_ZERO_TARGET_LABEL]: String(input.targetReplicas ?? Math.max(1, s.replicas.desired || 1)),
          [SCALE_TO_ZERO_IDLE_LABEL]: String(input.idleSeconds ?? 300),
        },
        removeKeys: [],
      }
    : {
        service: s.name,
        add: {},
        removeKeys: [SCALE_TO_ZERO_LABEL, SCALE_TO_ZERO_TARGET_LABEL, SCALE_TO_ZERO_IDLE_LABEL],
      };
  try {
    await ctx.hub.dispatch(node.id, 'service.updateLabels', payload);
  } catch (e) {
    throw mapDispatchError(e);
  }
  return { id: s.id, ok: true };
}

/** Wake a sleeping (scaled-to-zero) service to its target replicas. */
export async function wakeService(ctx: OrgContext, id: string): Promise<{ id: string; woke: boolean }> {
  const s = liveService(ctx, id);
  if (!s) throw notFound('service', id);
  const target = Number(s.labels[SCALE_TO_ZERO_TARGET_LABEL]) || 1;
  if (s.replicas.desired >= target) return { id: s.id, woke: false };
  const node = await resolveManagerNode(ctx);
  try {
    await ctx.hub.dispatch(node.id, 'service.scale', { service: s.name, replicas: target });
  } catch (e) {
    throw mapDispatchError(e);
  }
  return { id: s.id, woke: true };
}

export { recordToEnvArray };
