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
import { resolveManagerNode } from './dispatch.service';
import { enqueueEvent } from './webhooks-out.service';

function envArrayToRecord(env: { key: string; value: string }[]): Record<string, string> {
  return Object.fromEntries(env.map((e) => [e.key, e.value]));
}

function recordToEnvArray(env: Record<string, string>): { key: string; value: string }[] {
  return Object.entries(env).map(([key, value]) => ({ key, value }));
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

/** Project a live InvService into the dashboard's service summary. No DB. */
function toSummary(s: InvService): ServiceSummary {
  return {
    id: s.id,
    name: s.name,
    image: s.image,
    status: INV_STATUS[s.status],
    // Ingress is on when the service carries the `swarmy.ingress` label or publishes a port.
    ingressEnabled: s.labels['swarmy.ingress'] === 'true' || s.ports.length > 0,
    replicas: s.replicas,
    // Placement is derived from live containers at detail level; omitted in summaries.
    nodeId: null,
    stackId: s.stack === '(ungrouped)' ? null : s.stack,
    updatedAt: new Date().toISOString(),
  };
}

export function listServices(
  ctx: OrgContext,
  filter?: { nodeId?: string; stackId?: string; status?: string; search?: string },
): ServiceSummary[] {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  let inv = buildInventory(services, containers).services;
  if (filter?.stackId) inv = inv.filter((s) => s.stack === filter.stackId);
  if (filter?.search) {
    const q = filter.search.toLowerCase();
    inv = inv.filter((s) => s.name.toLowerCase().includes(q));
  }
  if (filter?.status) inv = inv.filter((s) => INV_STATUS[s.status] === filter.status);
  if (filter?.nodeId) {
    // Placement filter: enrollment nodeId → Docker swarm node id → services with a task there.
    const swarmNodeId = ctx.hub.swarmNodeIdFor(filter.nodeId);
    const onNode = new Set<string>();
    if (swarmNodeId) {
      for (const c of containers) {
        if (c.labels['com.docker.swarm.node.id'] === swarmNodeId && c.serviceId) {
          onNode.add(c.serviceId);
        }
      }
    }
    inv = inv.filter((s) => onNode.has(s.id));
  }
  return inv.map(toSummary);
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
export function liveService(ctx: OrgContext, idOrName: string): InvService | undefined {
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
    throw mapDispatchError(e);
  }
  // Swarm state lives in Docker now (no DB row). Resolve the live service id; the
  // name is a stable fallback until inventory catches up. deploymentId is non-persisted.
  const id = liveService(ctx, input.name)?.id ?? input.name;
  // Outbound webhook: fan a `service.deployed` event out to subscribed endpoints.
  await enqueueEvent(ctx.db, ctx.activeOrgId, 'service.deployed', {
    serviceId: id,
    name: input.name,
    image: input.image,
    deploymentId: id,
  }).catch(() => undefined); // best-effort; never blocks the deploy
  return { id, deploymentId: id };
}

export async function updateService(
  ctx: OrgContext,
  input: UpdateServiceInput,
): Promise<{ id: string; deploymentId: string }> {
  const existing = liveService(ctx, input.id);
  if (!existing) throw notFound('service', input.id);
  const node = await resolveManagerNode(ctx);

  // Reconstruct prior env from the live service's `KEY=VALUE` entries.
  const existingEnv: Record<string, string> = {};
  for (const kv of existing.env) {
    const i = kv.indexOf('=');
    existingEnv[i >= 0 ? kv.slice(0, i) : kv] = i >= 0 ? kv.slice(i + 1) : '';
  }

  // Live inventory does not expose command/mounts/constraints — callers re-specify
  // those on update; networks/ports/env/replicas are merged over live truth.
  const merged = {
    name: input.name ?? existing.name,
    image: input.image ?? existing.image,
    replicas: input.replicas ?? existing.replicas.desired,
    env: input.env ? envArrayToRecord(input.env) : existingEnv,
    command: input.command ?? [],
    ports:
      input.ports ??
      existing.ports.map((p) => ({
        target: p.target,
        published: p.published,
        protocol: p.protocol,
        mode: 'ingress' as const,
      })),
    volumes: input.volumes ?? [],
    networks: input.networks ?? existing.networks.map((n) => n.name),
    constraints: input.constraints ?? [],
    project: input.project ?? (existing.stack === '(ungrouped)' ? undefined : existing.stack),
  };

  try {
    await ctx.hub.dispatch(node.id, 'service.deploy', {
      spec: buildServiceSpec(merged),
      pullPolicy: 'always',
    });
  } catch (e) {
    throw mapDispatchError(e);
  }
  const id = liveService(ctx, merged.name)?.id ?? existing.id;
  return { id, deploymentId: id };
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

/**
 * Full raw `docker service inspect` for one service (complete spec + task/update
 * status) — for the details/debug view. Resolves the live service NAME from the
 * inventory, routes to a manager, and returns the inspect JSON as-is.
 */
export async function inspectService(
  ctx: OrgContext,
  idOrName: string,
): Promise<Record<string, unknown>> {
  const svc = liveService(ctx, idOrName);
  if (!svc) throw notFound('service', idOrName);
  const node = await resolveManagerNode(ctx);
  try {
    const res = await ctx.hub.dispatch<{ inspect: unknown }>(node.id, 'service.inspect', {
      service: svc.name,
    });
    return (res?.inspect ?? {}) as Record<string, unknown>;
  } catch (e) {
    throw mapDispatchError(e);
  }
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

/** Persist a service's canvas position as Docker labels (swarmy.canvas.x/y) —
 *  layout is Docker-truth, not stored in swarmy's DB. */
export async function setCanvasPosition(
  ctx: OrgContext,
  input: { id: string; x: number; y: number },
): Promise<{ id: string; ok: true }> {
  const s = liveService(ctx, input.id);
  if (!s) throw notFound('service', input.id);
  const node = await resolveManagerNode(ctx);
  try {
    await ctx.hub.dispatch(node.id, 'service.updateLabels', {
      service: s.name,
      add: { 'swarmy.canvas.x': String(Math.round(input.x)), 'swarmy.canvas.y': String(Math.round(input.y)) },
      removeKeys: [],
    });
  } catch (e) {
    throw mapDispatchError(e);
  }
  return { id: s.id, ok: true };
}

export { recordToEnvArray };
