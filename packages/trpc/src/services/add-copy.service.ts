/**
 * "⌥-drag to add a copy" (board 9) — the IO half of `@swarmy/core`
 * `add-copy.ts`. Gathers the service's live placement (its spec, never the
 * lossy inventory view), the swarm's servers and what runs on each, and asks
 * the pure rule whether one more copy would start on the server it was
 * dropped on. On a yes only the copy count changes (`service.scale`: nothing
 * restarts, no pin is written); a service that sleeps when idle wakes to the
 * new count too. Audited `service.copy.add`.
 */
import {
  SCALE_TO_ZERO_LABEL,
  SCALE_TO_ZERO_TARGET_LABEL,
  STACK_LABEL,
  SYSTEM_STACK,
  SYSTEM_STACK_LABEL,
  planAddCopy,
  type AddCopyPlan,
  type CopyServer,
} from '@swarmy/core';
import type { SwarmNodeInfo, SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { commandRejected, mapDispatchError, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { resolveManagerNode } from './dispatch.service';
import { liveServiceSpec } from './service-patch';
import { nodesRunning, serviceVolumes } from './volumeMove.service';

const SERVICE_NAME_LABEL = 'com.docker.swarm.service.name';

type Ctx = OrgContext;
export type CopyPlanView = AddCopyPlan & { service: string; to: string };

/** Every swarm server as a place for the copy: its labels, and the tasks its agent reports. */
function copyServers(ctx: Ctx, service: string): CopyServer[] {
  const online = ctx.hub.onlineNodeIds();
  const controllerOf = (sw: string) => online.find((id) => ctx.hub.swarmNodeIdFor(id) === sw);
  const swarm = ctx.hub.nodeInventory(ctx.activeOrgId);
  const nodes: SwarmNodeInfo[] = swarm.length ? swarm : online.map((id) => ctx.hub.nodeInfoFor(id)).filter((n): n is SwarmNodeInfo => Boolean(n));
  return nodes.map((n) => {
    const id = controllerOf(n.swarmNodeId);
    const running = id ? ctx.hub.latestContainers(id).filter((c) => c.state === 'running' && c.labels?.[SERVICE_NAME_LABEL]) : null;
    return {
      id: id ?? `swarm:${n.swarmNodeId}`,
      name: n.hostname,
      ready: Boolean(id) && n.status === 'ready' && n.availability === 'active',
      copies: running ? running.filter((c) => c.labels?.[SERVICE_NAME_LABEL] === service).length : null,
      tasks: running ? running.length : null,
      node: { swarmNodeId: n.swarmNodeId, hostname: n.hostname, role: n.role, os: n.os, arch: n.arch, labels: n.labels ?? {} },
    };
  });
}

async function gather(ctx: Ctx, input: { id: string; toNodeId: string }): Promise<{ svc: SwarmServiceInfo; plan: CopyPlanView; manager: { id: string } }> {
  const svc = ctx.hub.liveInventory(ctx.activeOrgId).services.find((s) => s.id === input.id || s.name === input.id);
  if (!svc) throw notFound('service', input.id);
  const manager = await resolveManagerNode(ctx);
  const spec = await liveServiceSpec(ctx, manager.id, svc);
  const stack = svc.labels[STACK_LABEL];
  const short = stack && svc.name.startsWith(`${stack}_`) ? svc.name.slice(stack.length + 1) : svc.name;
  const plan = planAddCopy({
    service: {
      short,
      mode: svc.mode,
      desired: svc.desiredReplicas ?? 0,
      system: stack === SYSTEM_STACK || svc.labels[SYSTEM_STACK_LABEL] === 'true',
      labels: svc.labels,
      volumes: serviceVolumes(ctx, svc, nodesRunning(ctx, svc.name)[0]),
      placement: spec.placement,
    },
    to: input.toNodeId,
    servers: copyServers(ctx, svc.name),
  });
  return { svc, manager, plan: { ...plan, service: svc.name, to: input.toNodeId } };
}

/** Would one more copy start on `toNodeId`? Read-only: the screen's preview. */
export async function copyPlan(ctx: Ctx, input: { id: string; toNodeId: string }): Promise<CopyPlanView> {
  return (await gather(ctx, input)).plan;
}

/** Add the copy (re-checked here, so a stale preview can't skip a refusal). */
export async function addCopy(ctx: Ctx, input: { id: string; toNodeId: string }): Promise<{ service: string; replicas: number; to: string }> {
  const { svc, manager, plan } = await gather(ctx, input);
  if (!plan.ok) throw commandRejected(plan.reason);
  try {
    await ctx.hub.dispatch(manager.id, 'service.scale', { service: svc.name, replicas: plan.replicas });
    if (svc.labels[SCALE_TO_ZERO_LABEL] === 'true') {
      await ctx.hub.dispatch(manager.id, 'service.updateLabels', { service: svc.name, add: { [SCALE_TO_ZERO_TARGET_LABEL]: String(plan.replicas) }, removeKeys: [] });
    }
  } catch (e) {
    throw mapDispatchError(e);
  }
  const to = ctx.hub.nodeInfoFor(input.toNodeId)?.hostname ?? input.toNodeId;
  await writeAudit(ctx, {
    action: 'service.copy.add',
    targetType: 'service',
    targetId: svc.id,
    metadata: { name: svc.name, from: svc.desiredReplicas ?? 0, to: plan.replicas, server: to },
  });
  return { service: svc.name, replicas: plan.replicas, to };
}
