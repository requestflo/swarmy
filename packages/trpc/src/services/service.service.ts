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
import { commandRejected, mapDispatchError, notFound } from '../errors';
import { enforceAdmission } from './admission-gate';
import { writeAudit } from './audit.service';
import { pinToNodeConstraint, resolveManagerNode } from './dispatch.service';
import { patchLiveService } from './service-patch';
import {
  listAppSecretVersions,
  materializeSecretVars,
  mountedVersions,
  partitionEnv,
  planSecretSpec,
  secretKeysFromEnv,
  versionsOf,
} from './app-secrets.service';
import { applySecretVars, SECRET_ENV_VAR } from '@swarmy/core';
import { enqueueEvent } from './webhooks-out.service';

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
    ...(row.constraints.length ? { placement: { constraints: row.constraints } } : {}),
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
  failing: 'failed',
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
  // Secret vars: names only (values are Docker secrets, never in the spec).
  // `_FILE` pointers of file-delivered ones are shown as-is (they are paths).
  const secretKeys = secretKeysFromEnv(env, s.secrets ?? [], null, s.name);
  for (const k of Object.keys(env)) {
    if (k === SECRET_ENV_VAR) delete env[k];
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
    ...(Object.keys(secretKeys).length ? { secretKeys } : {}),
    ...(s.lastError ? { lastError: s.lastError } : {}),
    ...(s.lastErrorAt ? { lastErrorAt: new Date(s.lastErrorAt).toISOString() } : {}),
  };
}

export async function createService(
  ctx: OrgContext,
  input: CreateServiceInput,
): Promise<{ id: string; deploymentId: string }> {
  const node = await resolveManagerNode(ctx);
  const { plain, secrets } = partitionEnv(input.env);
  let spec = buildServiceSpec({
    name: input.name,
    image: input.image,
    replicas: input.replicas,
    env: plain,
    command: input.command,
    ports: input.ports,
    volumes: input.volumes,
    networks: input.networks,
    constraints: input.nodeId ? [...input.constraints, pinToNodeConstraint(ctx, input.nodeId)] : input.constraints,
    project: input.project,
  });

  // Secret vars → Docker secrets (`<name>_<KEY>_v1`), mounted by name. The
  // admission gate + the deploy below only ever see the secret NAMES.
  let secretKeys: string[] = [];
  if (secrets.length > 0) {
    for (const sv of secrets) {
      if (!sv.value) throw commandRejected(`secret ${sv.key} needs a value`);
    }
    const owned = versionsOf(await listAppSecretVersions(ctx, node.id), input.name);
    const { desired } = await materializeSecretVars(ctx, node.id, input.name, secrets, owned, new Map());
    spec = applySecretVars(spec, desired, new Set());
    secretKeys = desired.map((d) => d.key);
  }

  // "Ship a service" is a service deploy: it runs the same admission spine
  // (guardrails / exposure / image policy) with the same refuse/override/audit
  // semantics as `deployFromCompose` — before anything touches the swarm.
  await enforceAdmission(
    ctx,
    {
      kind: 'service.deploy',
      orgId: ctx.activeOrgId,
      stackName: input.project,
      specs: [spec],
      override: input.override,
    },
    { targetType: 'service', targetId: input.name },
  );

  try {
    await ctx.hub.dispatch(node.id, 'service.deploy', { spec, pullPolicy: 'always' });
  } catch (e) {
    throw mapDispatchError(e);
  }
  // Swarm state lives in Docker now (no DB row). Resolve the live service id; the
  // name is a stable fallback until inventory catches up. deploymentId is non-persisted.
  const id = liveService(ctx, input.name)?.id ?? input.name;
  await writeAudit(ctx, {
    action: 'service.deploy',
    targetType: 'service',
    targetId: id,
    metadata: {
      name: input.name,
      image: input.image,
      stack: input.project ?? null,
      replicas: input.replicas,
      override: input.override === true,
      ...(secretKeys.length ? { secretVars: secretKeys } : {}),
    },
  });
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

  const project = input.project ?? (existing.stack === '(ungrouped)' ? undefined : existing.stack);
  const name = input.name ?? existing.name;
  const image = input.image ?? existing.image;

  // Secret vars: upserts (secret: true; empty value = keep), explicit removals,
  // and demotions (a key now sent as plain env). New values become new Docker
  // secret versions BEFORE the rollout; nothing here ever reads a value back.
  const parts = input.env ? partitionEnv(input.env) : null;
  const secretChange =
    (parts?.secrets.length ?? 0) > 0 ||
    (input.removeSecretKeys?.length ?? 0) > 0 ||
    (parts !== null && (existing.secrets?.length ?? 0) > 0);
  let secretPlan: ((spec: ServiceSpec, live: ServiceSpec) => ServiceSpec) | null = null;
  let secretAudit: { set: string[]; rotated: string[]; removed: string[] } | null = null;
  if (secretChange) {
    const owned = versionsOf(await listAppSecretVersions(ctx, node.id), existing.name);
    const mounted = mountedVersions(owned, existing.secrets ?? []);
    const upserts = parts?.secrets ?? [];
    const { desired, rotated } = await materializeSecretVars(ctx, node.id, existing.name, upserts, owned, mounted);
    const demote = parts ? Object.keys(parts.plain).filter((k) => mounted.has(k)) : [];
    const remove = (input.removeSecretKeys ?? []).filter((k) => mounted.has(k));
    secretPlan = (spec, live) => planSecretSpec(spec, owned, { upserts: desired, remove, demote }, live);
    if (upserts.length || remove.length || demote.length) {
      secretAudit = {
        set: desired.map((d) => d.key),
        rotated: rotated.map((r) => `${r.key}@v${r.version}`),
        removed: [...remove, ...demote],
      };
    }
  }

  // Patch the FULL live spec (service.inspect): only the fields the caller
  // names are replaced; everything else — mounts, command, placement,
  // resources, healthcheck, secrets/configs (with targets), restart policy and
  // the live label set (swarmy.env, ingress routes, deploy safety, …) — is
  // carried. Rebuilding from the inventory would strip volumes and take a
  // production service out of guardrail scope.
  await patchLiveService(
    ctx,
    existing,
    {
      image,
      setLabels: {
        'swarmy.managed': 'true',
        ...(project ? { 'com.docker.stack.namespace': project } : {}),
      },
      transform: (live) => {
        const out: ServiceSpec = { ...live, name };
        if (input.replicas !== undefined) out.mode = { replicated: { replicas: input.replicas } };
        if (parts) {
          // Plain env is authoritative; secret-var plumbing (`_FILE`
          // pointers, secretEnv) is re-derived by the secret plan below.
          out.env = parts.plain;
        }
        if (input.command) {
          if (input.command.length > 0) out.command = input.command;
          else delete out.command;
        }
        if (input.ports) {
          out.ports = input.ports.map((p) => ({
            target: p.target,
            published: p.published,
            protocol: p.protocol === 'udp' ? 'udp' : 'tcp',
            mode: p.mode === 'host' ? 'host' : 'ingress',
          }));
        }
        if (input.volumes) {
          out.mounts = input.volumes.map((v) => ({
            type: v.type === 'bind' ? 'bind' : v.type === 'tmpfs' ? 'tmpfs' : 'volume',
            source: v.source,
            target: v.target,
            readOnly: v.readOnly,
          }));
        }
        if (input.networks) out.networks = input.networks;
        if (input.constraints) {
          const { constraints: _drop, ...rest } = live.placement ?? {};
          const placement = input.constraints.length ? { ...rest, constraints: input.constraints } : rest;
          if (Object.keys(placement).length > 0) out.placement = placement;
          else delete out.placement;
        }
        return secretPlan ? secretPlan(out, live) : out;
      },
    },
    {
      nodeId: node.id,
      pullPolicy: 'always',
      // An update (new image/env/ports) is a service deploy — same admission gate.
      beforeDeploy: (spec) =>
        enforceAdmission(
          ctx,
          {
            kind: 'service.deploy',
            orgId: ctx.activeOrgId,
            stackName: project,
            specs: [spec],
            override: input.override,
          },
          { targetType: 'service', targetId: existing.name },
        ),
    },
  );
  const id = liveService(ctx, name)?.id ?? existing.id;
  await writeAudit(ctx, {
    action: 'service.deploy',
    targetType: 'service',
    targetId: id,
    metadata: {
      name,
      image,
      previousImage: existing.image,
      stack: project ?? null,
      update: true,
      override: input.override === true,
      ...(secretAudit ? { secretVars: secretAudit } : {}),
    },
  });
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
  await writeAudit(ctx, {
    action: 'service.scale',
    targetType: 'service',
    targetId: svc.id,
    metadata: { name: svc.name, from: svc.replicas.desired, to: input.replicas },
  });
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
  await writeAudit(ctx, {
    action: 'service.restart',
    targetType: 'service',
    targetId: svc.id,
    metadata: { name: svc.name },
  });
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
  await writeAudit(ctx, {
    action: 'service.remove',
    targetType: 'service',
    targetId: svc.id,
    metadata: { name: svc.name, stack: svc.stack },
  });
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
