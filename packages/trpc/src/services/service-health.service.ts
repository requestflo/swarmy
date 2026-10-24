import {
  healthcheckExecCmd,
  healthcheckTimeoutMs,
  type HealthCopyView,
  type HealthTestView,
  type ServiceHealthProbesView,
} from '@swarmy/core';
import type { ContainerInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { commandRejected, mapDispatchError, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { resolveManagerNode } from './dispatch.service';
import { resolveLiveService } from './live-resolve';
import { liveServiceSpec } from './service-patch';
import { terminalCapability } from './terminal.service';

/**
 * The health check, live (board AppRollout). `healthProbes` reads Docker's
 * own probe record off the agents' container snapshots (Docker keeps the
 * last 5 per container) — no dispatch. `testHealthcheck` runs the service's
 * check ONCE inside its newest running task through the existing container
 * exec path on the node hosting it — the same gate as every exec
 * (`swarmy.node.exec`, the box's SWARMY_ALLOW_EXEC) — and audits it.
 */

const SWARM_SERVICE_ID_LABEL = 'com.docker.swarm.service.id';
const OUTPUT_MAX = 2000;
const DISPATCH_MARGIN_MS = 5_000;

interface Copy {
  nodeId: string;
  container: ContainerInfo;
}

/** The service's running containers across the org's online nodes, newest first. */
function runningCopies(ctx: OrgContext, serviceId: string): Copy[] {
  const orgIds = new Set(ctx.hub.liveInventory(ctx.activeOrgId).containers.map((c) => c.id));
  const out: Copy[] = [];
  for (const nodeId of ctx.hub.onlineNodeIds()) {
    for (const c of ctx.hub.latestContainers(nodeId)) {
      const sid = c.serviceId ?? c.labels?.[SWARM_SERVICE_ID_LABEL];
      if (orgIds.has(c.id) && sid === serviceId && c.state === 'running') out.push({ nodeId, container: c });
    }
  }
  return out.sort((a, b) => Number(b.container.createdAt) - Number(a.container.createdAt));
}

const nodeName = (ctx: OrgContext, nodeId: string): string | null => ctx.hub.nodeInfoFor(nodeId)?.hostname ?? null;

export function serviceHealthProbes(ctx: OrgContext, idOrName: string): ServiceHealthProbesView {
  const svc = resolveLiveService(ctx, idOrName);
  if (!svc) throw notFound('service', idOrName);
  const copies: HealthCopyView[] = [];
  let test: string[] | null = null;
  for (const { nodeId, container: c } of runningCopies(ctx, svc.id)) {
    if (!c.health) continue;
    test ??= c.health.test?.length ? c.health.test : null;
    copies.push({
      nodeId,
      node: nodeName(ctx, nodeId),
      containerId: c.id,
      status: c.health.status,
      failingStreak: c.health.failingStreak,
      probes: c.health.probes,
    });
  }
  return { copies, test };
}

const trim = (s: string): string => (s.length > OUTPUT_MAX ? `${s.slice(0, OUTPUT_MAX - 1)}…` : s);

export async function testServiceHealthcheck(ctx: OrgContext, idOrName: string): Promise<HealthTestView> {
  const svc = resolveLiveService(ctx, idOrName);
  if (!svc) throw notFound('service', idOrName);
  const target = runningCopies(ctx, svc.id)[0];
  if (!target) throw commandRejected(`${svc.name} has no running copy to test its health check in — start it first`);
  const manager = await resolveManagerNode(ctx);
  const hc = (await liveServiceSpec(ctx, manager.id, svc)).healthcheck;
  if (hc?.disable) throw commandRejected(`${svc.name}’s health check is switched off, so there is nothing to test`);
  // No check of the service's own: the copy runs the image's (Config.Healthcheck).
  const cmd = healthcheckExecCmd(hc?.test?.length ? hc.test : target.container.health?.test);
  if (!cmd) throw commandRejected(`${svc.name} has no health check to test — add one first`);
  const cap = terminalCapability(ctx.hub, target.nodeId, 'container');
  if (!cap.capable) throw commandRejected(cap.message ?? 'container exec is off for this server');

  const timeoutMs = healthcheckTimeoutMs(hc);
  const at = Date.now();
  const started = performance.now();
  let view: HealthTestView;
  try {
    const res = await ctx.hub.dispatch<{ exitCode: number; output?: string; durationMs?: number }>(
      target.nodeId,
      'exec',
      { target: { containerId: target.container.id }, cmd, tty: false, stream: false, timeoutMs, nodeCapable: cap.capable },
      { timeoutMs: timeoutMs + DISPATCH_MARGIN_MS },
    );
    const durationMs = res.durationMs ?? Math.round(performance.now() - started);
    view = { ok: res.exitCode === 0, exitCode: res.exitCode, timedOut: false, durationMs, output: trim((res.output ?? '').trim()), at, node: nodeName(ctx, target.nodeId), containerId: target.container.id, cmd };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (!/timed out|timeout/i.test(message)) throw mapDispatchError(e);
    view = { ok: false, exitCode: null, timedOut: true, durationMs: timeoutMs, output: '', at, node: nodeName(ctx, target.nodeId), containerId: target.container.id, cmd };
  }
  await writeAudit(ctx, {
    action: 'service.healthcheck.test',
    targetType: 'service',
    targetId: svc.id,
    metadata: { name: svc.name, nodeId: target.nodeId, exitCode: view.exitCode, ok: view.ok, timedOut: view.timedOut },
  });
  return view;
}
