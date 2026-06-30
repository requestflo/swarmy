import { randomUUID } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { buildInventory, STACK_LABEL, UNGROUPED, type InvService } from '@swarmy/core';
import type { ServiceSpec } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { mapDispatchError, notFound } from '../errors';
import { resolveManagerNode } from './dispatch.service';
import { augmentSpecsForStack } from './otel-injection';
import { stackTelemetryEnabled } from './observability.service';

/**
 * Swarm state lives in Docker, not the DB. The Stack model is now config-only
 * (name + composeSource + ingress/telemetry flags); a stack's live status and
 * service membership are derived from the in-memory hub inventory, grouped by
 * the Docker stack-namespace label (`com.docker.stack.namespace`), whose value
 * is the swarmy stack name.
 */

/** Live services that belong to a stack, by its Docker stack-namespace label. */
function liveStackServices(ctx: OrgContext, stackName: string): InvService[] {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  return buildInventory(services, containers).services.filter((s) => s.stack === stackName);
}

/** Synthesize a stack-level status from its live services' statuses. */
function stackStatus(svcs: InvService[]): string {
  if (svcs.length === 0) return 'empty';
  if (svcs.some((s) => s.status === 'deploying')) return 'deploying';
  if (svcs.some((s) => s.status === 'degraded' || s.status === 'stopped')) return 'degraded';
  return 'running';
}

/** Stamp the swarmy-managed + stack-namespace labels so live inventory groups it. */
function withStackLabels(spec: ServiceSpec, stackName: string): ServiceSpec {
  return {
    ...spec,
    labels: { ...(spec.labels ?? {}), 'swarmy.managed': 'true', [STACK_LABEL]: stackName },
  };
}

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
  // Config rows (name + flags). Live status is LEFT-JOINed from Docker truth.
  const dbRows = await ctx.db.stack.findMany({
    where: { orgId: ctx.activeOrgId },
    select: { id: true, name: true },
  });
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  const byStack = new Map<string, InvService[]>();
  for (const s of buildInventory(services, containers).services) {
    if (s.stack === UNGROUPED) continue;
    const list = byStack.get(s.stack) ?? [];
    list.push(s);
    byStack.set(s.stack, list);
  }

  const now = new Date().toISOString();
  const seen = new Set<string>();
  const out: StackSummary[] = [];
  // DB-config stacks first (a config row with no live services shows empty).
  for (const r of dbRows) {
    seen.add(r.name);
    const svcs = byStack.get(r.name) ?? [];
    out.push({ id: r.id, name: r.name, serviceCount: svcs.length, status: stackStatus(svcs), updatedAt: now });
  }
  // Label-only stacks (live services grouped under a stack with no DB row).
  for (const [name, svcs] of byStack) {
    if (seen.has(name)) continue;
    out.push({ id: name, name, serviceCount: svcs.length, status: stackStatus(svcs), updatedAt: now });
  }
  return out;
}

export async function getStack(ctx: OrgContext, id: string): Promise<StackDetail> {
  // composeSource is config (kept on the Stack row); membership/status is live.
  const row = await ctx.db.stack.findFirst({
    where: { id, orgId: ctx.activeOrgId },
    select: { id: true, name: true, composeSource: true },
  });
  if (!row) throw notFound('stack', id);
  const svcs = liveStackServices(ctx, row.name);
  const now = new Date().toISOString();
  return {
    id: row.id,
    name: row.name,
    serviceCount: svcs.length,
    status: stackStatus(svcs),
    updatedAt: now,
    composeSource: row.composeSource,
    services: svcs.map((s) => ({ id: s.id, name: s.name, image: s.image })),
    createdAt: now,
  };
}

export async function deployFromCompose(
  ctx: OrgContext,
  input: { name: string; composeSource: string },
): Promise<{ id: string; deploymentId: string }> {
  const specs = composeToSpecs(input.composeSource);
  const node = await resolveManagerNode(ctx);

  // Persist only the stack CONFIG (name + composeSource); status/membership are
  // read back live from Docker. No Service/Deployment rows are written.
  const stack = await ctx.db.stack.upsert({
    where: { orgId_name: { orgId: ctx.activeOrgId, name: input.name } },
    create: {
      orgId: ctx.activeOrgId,
      name: input.name,
      composeSource: input.composeSource,
    },
    update: { composeSource: input.composeSource },
    select: { id: true, name: true },
  });

  const finalSpecs = augmentSpecsForStack(specs, {
    telemetryEnabled: stackTelemetryEnabled(ctx, stack.name),
    orgId: ctx.activeOrgId,
    stack: stack.name,
  }).map((spec) => withStackLabels(spec, stack.name));

  // Non-persisted deploy correlation id — keeps the API shape without a DB row.
  const deploymentId = randomUUID();
  try {
    for (const spec of finalSpecs) {
      await ctx.hub.dispatch(node.id, 'service.deploy', { spec, pullPolicy: 'always' });
    }
  } catch (e) {
    throw mapDispatchError(e);
  }

  return { id: stack.id, deploymentId };
}

export interface AddServiceToStackInput {
  /** Target stack name = the Docker stack-namespace the new service is stamped into. */
  stack: string;
  name: string;
  image: string;
  ports?: { target: number; published?: number; protocol?: 'tcp' | 'udp' }[];
  env?: Record<string, string>;
  replicas?: number;
}

/**
 * Contextual deploy: drop ONE app straight into an existing stack. Builds a
 * minimal `ServiceSpec`, runs it through the stack's telemetry injection (a
 * no-op when the stack isn't opted in), stamps the swarmy-managed +
 * stack-namespace labels so live inventory groups it under <stack>, and
 * dispatches `service.deploy` — reusing the exact spec/label/deploy path as
 * `deployFromCompose`. No Service/Deployment DB rows are written (Docker truth).
 */
export async function addServiceToStack(
  ctx: OrgContext,
  input: AddServiceToStackInput,
): Promise<{ id: string; deploymentId: string }> {
  const node = await resolveManagerNode(ctx);

  const baseSpec: ServiceSpec = {
    name: input.name,
    image: input.image,
    mode: { replicated: { replicas: input.replicas ?? 1 } },
    env: input.env && Object.keys(input.env).length ? input.env : undefined,
    ports: input.ports?.length
      ? input.ports.map((p) => ({
          target: p.target,
          published: p.published,
          protocol: p.protocol ?? ('tcp' as const),
          mode: 'ingress' as const,
        }))
      : undefined,
  };

  // Same augmentation pipeline as the compose path: telemetry first, then the
  // stack-namespace + swarmy.managed labels.
  const [spec] = augmentSpecsForStack([baseSpec], {
    telemetryEnabled: stackTelemetryEnabled(ctx, input.stack),
    orgId: ctx.activeOrgId,
    stack: input.stack,
  }).map((s) => withStackLabels(s, input.stack));

  const deploymentId = randomUUID();
  try {
    await ctx.hub.dispatch(node.id, 'service.deploy', { spec, pullPolicy: 'always' });
  } catch (e) {
    throw mapDispatchError(e);
  }

  // Best-effort live id (inventory is eventually consistent); name is the stable
  // fallback until the new service surfaces under the stack.
  const id = liveStackServices(ctx, input.stack).find((s) => s.name === input.name)?.id ?? input.name;
  return { id, deploymentId };
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
    select: { id: true, name: true },
  });
  if (!stack) throw notFound('stack', id);
  const node = await resolveManagerNode(ctx).catch(() => null);
  if (node) {
    // Service membership comes from live Docker inventory, not a DB relation.
    for (const svc of liveStackServices(ctx, stack.name)) {
      await ctx.hub.dispatch(node.id, 'service.remove', { service: svc.name }).catch(() => undefined);
    }
  }
  await ctx.db.stack.delete({ where: { id } });
  return { id, removed: true };
}
