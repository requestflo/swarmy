import type { InvService } from '@swarmy/core';
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

export function getDeployStatus(ctx: OrgContext, deploymentId: string): DeployStatus {
  const svc = liveService(ctx, deploymentId);
  if (!svc) throw notFound('deployment', deploymentId);
  return synth(svc, deploymentId);
}

export function getLatestServiceDeployStatus(
  ctx: OrgContext,
  serviceId: string,
): DeployStatus | null {
  const svc = liveService(ctx, serviceId);
  return svc ? synth(svc, svc.id) : null;
}
