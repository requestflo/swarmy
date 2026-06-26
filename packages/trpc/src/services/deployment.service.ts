import type { DeployPhase, DeployStatus } from '@swarmy/core/views';
import type { OrgContext } from '../context';
import { notFound } from '../errors';

interface DeploymentRow {
  id: string;
  serviceId: string | null;
  kind: string;
  phase: string;
  desired: number | null;
  ready: number | null;
  message: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

function phaseView(p: string): DeployPhase {
  const map: Record<string, DeployPhase> = {
    QUEUED: 'queued',
    PULLING: 'pulling',
    CREATING: 'creating',
    CONVERGING: 'converging',
    COMPLETE: 'complete',
    FAILED: 'failed',
    ROLLEDBACK: 'rolledback',
    CANCELED: 'canceled',
  };
  return map[p] ?? 'queued';
}

function toStatus(d: DeploymentRow): DeployStatus {
  return {
    deploymentId: d.id,
    serviceId: d.serviceId,
    kind: d.kind,
    phase: phaseView(d.phase),
    desired: d.desired,
    ready: d.ready,
    message: d.message,
    startedAt: d.startedAt.toISOString(),
    finishedAt: d.finishedAt ? d.finishedAt.toISOString() : null,
  };
}

export async function getDeployStatus(ctx: OrgContext, deploymentId: string): Promise<DeployStatus> {
  const d = (await ctx.db.deployment.findFirst({
    where: { id: deploymentId, orgId: ctx.activeOrgId },
  })) as DeploymentRow | null;
  if (!d) throw notFound('deployment', deploymentId);
  return toStatus(d);
}

export async function getLatestServiceDeployStatus(
  ctx: OrgContext,
  serviceId: string,
): Promise<DeployStatus | null> {
  const d = (await ctx.db.deployment.findFirst({
    where: { serviceId, orgId: ctx.activeOrgId },
    orderBy: { startedAt: 'desc' },
  })) as DeploymentRow | null;
  return d ? toStatus(d) : null;
}

const TERMINAL: DeployPhase[] = ['complete', 'failed', 'rolledback', 'canceled'];

/** Poll a deployment's status until it reaches a terminal phase or aborts. */
export async function* watchDeployStatus(
  ctx: OrgContext,
  deploymentId: string,
  signal: AbortSignal,
): AsyncGenerator<DeployStatus> {
  while (!signal.aborted) {
    const status = await getDeployStatus(ctx, deploymentId);
    yield status;
    if (TERMINAL.includes(status.phase)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
