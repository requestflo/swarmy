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
 * Stack deploys the controller accepted, so a poll right after POST /stacks
 * answers "queued" instead of 404 while the live inventory catches up (it
 * lags the dispatch by a few seconds). In memory, per org+stack, with the
 * service names the deploy expects. Entries expire after ACCEPTED_TTL_MS.
 */
const ACCEPTED_TTL_MS = 15 * 60_000;
const acceptedStackDeploys = new Map<string, { at: number; services: string[] }>();

export function noteStackDeployAccepted(orgId: string, stack: string, services: string[], now = Date.now()): void {
  acceptedStackDeploys.set(`${orgId}\u0000${stack}`, { at: now, services: [...services] });
}

/** The deploy failed before anything landed: stop answering "queued" for it. */
export function forgetStackDeploy(orgId: string, stack: string): void {
  acceptedStackDeploys.delete(`${orgId}\u0000${stack}`);
}

export function acceptedStackDeploy(orgId: string, stack: string, now = Date.now()): { at: number; services: string[] } | undefined {
  const key = `${orgId}\u0000${stack}`;
  const hit = acceptedStackDeploys.get(key);
  if (hit && now - hit.at > ACCEPTED_TTL_MS) {
    acceptedStackDeploys.delete(key);
    return undefined;
  }
  return hit;
}

/**
 * A stack deploy's convergence: every service of the stack, summed. Complete
 * once each one runs its desired count; pulling while any is still pulling
 * its image. `expected` (the accepted deploy's service names) keeps it
 * "converging" while any expected service hasn't shown up yet, and turns "no
 * live services" into "queued" instead of null. Null only when neither exists.
 * PURE — exported for tests.
 */
export function synthStack(
  services: InvService[],
  deploymentId: string,
  progress: (name: string) => DeployProgress | undefined = () => undefined,
  expected?: { at: number; services: string[] },
): DeployStatus | null {
  if (services.length === 0) {
    if (!expected) return null;
    return {
      deploymentId,
      serviceId: null,
      kind: 'stack.deploy',
      phase: 'queued',
      desired: null,
      ready: 0,
      message: 'deploy accepted; waiting for the services to appear',
      startedAt: new Date(expected.at).toISOString(),
      finishedAt: null,
    };
  }
  const missing = (expected?.services ?? []).filter((n) => !services.some((s) => s.name === n));
  const desired = services.reduce((n, s) => n + s.replicas.desired, 0);
  const ready = services.reduce((n, s) => n + Math.min(s.replicas.running, s.replicas.desired), 0);
  const pulling = services.map((s) => progress(s.name)).find((p): p is DeployProgress => !!p);
  const complete = !pulling && missing.length === 0 && services.every((s) => s.replicas.running >= s.replicas.desired);
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
    const status = synthStack(
      members,
      deploymentId,
      (name) => progressFor(ctx, name),
      acceptedStackDeploy(ctx.activeOrgId, stack),
    );
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
