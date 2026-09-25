import { buildInventory, type InvService } from '@swarmy/core';
import type { DeployPhase, DeployStatus } from '@swarmy/core/views';
import type { OrgContext } from '../context';
import { notFound } from '../errors';
import { liveService } from './service.service';

/**
 * Deployments are no longer persisted. A "deployment" is just the live
 * convergence of a service: we synthesize a {@link DeployStatus} from the
 * Docker-truth inventory (running vs. desired replicas). The `deploymentId`
 * carried by callers is the service's id/name, which resolves the live service.
 */

/** Synthesize a deploy status from a live service's replica convergence. */
function synth(svc: InvService, deploymentId: string): DeployStatus {
  const { desired, running } = svc.replicas;
  // Converged once the running count meets the desired count (desired 0 included).
  const complete = running >= desired;
  const phase: DeployPhase = complete ? 'complete' : 'converging';
  const now = new Date().toISOString();
  return {
    deploymentId,
    serviceId: svc.id,
    kind: 'deploy',
    phase,
    desired,
    ready: running,
    message: null,
    startedAt: now,
    finishedAt: complete ? now : null,
  };
}

/** Deployment id of a whole-stack deploy (`stacks.deployFromCompose`): pollable. */
export const STACK_DEPLOYMENT_PREFIX = 'stack:';
export function stackDeploymentId(stack: string): string {
  return `${STACK_DEPLOYMENT_PREFIX}${stack}`;
}

/**
 * A stack deploy's convergence: every service of the stack, summed. Complete
 * once each one runs its desired count; pulling while any is still pulling
 * its image. Null when the stack has no live services (yet). PURE — exported
 * for tests.
 */
export function synthStack(
  services: InvService[],
  deploymentId: string,
  progress: (name: string) => DeployProgress | undefined = () => undefined,
): DeployStatus | null {
  if (services.length === 0) return null;
  const desired = services.reduce((n, s) => n + s.replicas.desired, 0);
  const ready = services.reduce((n, s) => n + Math.min(s.replicas.running, s.replicas.desired), 0);
  const pulling = services.map((s) => progress(s.name)).find((p): p is DeployProgress => !!p);
  const complete = !pulling && services.every((s) => s.replicas.running >= s.replicas.desired);
  const now = new Date().toISOString();
  return {
    deploymentId,
    serviceId: null,
    kind: 'stack.deploy',
    phase: pulling ? pulling.phase : complete ? 'complete' : 'converging',
    desired,
    ready,
    message: pulling ? (pulling.message ?? 'pulling image…') : null,
    startedAt: pulling ? new Date(pulling.startedAt).toISOString() : now,
    finishedAt: complete ? now : null,
  };
}

type DeployProgress = NonNullable<ReturnType<NonNullable<OrgContext['hub']['deployProgress']>>>;

/**
 * Overlay an in-flight deploy's agent-reported progress (the deploy is pulling
 * its image before it can touch the service) onto the synthesized status, so
 * the dashboard says "pulling" instead of "complete" while a big image lands.
 * With no live service yet (a first deploy), synthesize from the progress alone.
 * PURE — exported for tests.
 */
export function withDeployProgress(
  status: DeployStatus | null,
  progress: DeployProgress | undefined,
  deploymentId: string,
): DeployStatus | null {
  if (!progress) return status;
  return {
    deploymentId: status?.deploymentId ?? deploymentId,
    serviceId: status?.serviceId ?? null,
    kind: 'deploy',
    desired: status?.desired ?? null,
    ready: status?.ready ?? null,
    phase: progress.phase,
    message: progress.message ?? 'pulling image…',
    startedAt: new Date(progress.startedAt).toISOString(),
    finishedAt: null,
  };
}

function progressFor(ctx: OrgContext, name: string): DeployProgress | undefined {
  return ctx.hub.deployProgress?.(ctx.activeOrgId, name);
}

export function getDeployStatus(ctx: OrgContext, deploymentId: string): DeployStatus {
  if (deploymentId.startsWith(STACK_DEPLOYMENT_PREFIX)) {
    const stack = deploymentId.slice(STACK_DEPLOYMENT_PREFIX.length);
    const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
    const members = buildInventory(services, containers).services.filter((s) => s.stack === stack);
    const status = synthStack(members, deploymentId, (name) => progressFor(ctx, name));
    if (!status) throw notFound('deployment', deploymentId);
    return status;
  }
  const svc = liveService(ctx, deploymentId);
  const status = withDeployProgress(
    svc ? synth(svc, deploymentId) : null,
    progressFor(ctx, svc?.name ?? deploymentId),
    deploymentId,
  );
  if (!status) throw notFound('deployment', deploymentId);
  return status;
}

export function getLatestServiceDeployStatus(
  ctx: OrgContext,
  serviceId: string,
): DeployStatus | null {
  const svc = liveService(ctx, serviceId);
  if (!svc) return null;
  return withDeployProgress(synth(svc, svc.id), progressFor(ctx, svc.name), svc.id);
}
