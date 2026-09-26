/**
 * Traced deploys: mint a deploy id, let the deploy paths add the stages the
 * controller owns, and serve the stream (replay + live tail) to the org that
 * started it. The agent's own stages arrive through the gateway relay
 * (apps/api/src/gateway/protocol-handlers.ts `deployProgress`).
 */
import type { DeployEventDetail, DeployEventStatus, DeployStage } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { notFound } from '../errors';
import { deployEventBus, type DeployEvent, type DeployTraceView } from './deploy-events';

/** Where the controller's own stages say they ran. */
export const CONTROLLER_NODE = 'swarmy';

export interface DeployTrace {
  id: string;
  stack: string;
  emit(e: {
    stage: DeployStage;
    status: DeployEventStatus;
    message: string;
    service?: string;
    node?: string;
    detail?: DeployEventDetail;
  }): void;
  finish(): void;
}

export function beginDeployTrace(ctx: OrgContext, stack: string, bus = deployEventBus): DeployTrace {
  const orgId = ctx.activeOrgId;
  const id = bus.begin(orgId, stack);
  return {
    id,
    stack,
    emit: (e) => {
      bus.push(orgId, {
        deployId: id,
        stack,
        node: e.node ?? CONTROLLER_NODE,
        stage: e.stage,
        status: e.status,
        at: Date.now(),
        message: e.message.slice(0, 300) || e.stage,
        ...(e.service ? { service: e.service } : {}),
        ...(e.detail ? { detail: e.detail } : {}),
      });
    },
    finish: () => bus.finish(id),
  };
}

/** `deploys.get`: the buffered events of one of this org's deploys. */
export function getDeployEvents(ctx: OrgContext, deployId: string, bus = deployEventBus): DeployTraceView {
  const t = bus.get(ctx.activeOrgId, deployId);
  if (!t) throw notFound('deploy', deployId);
  return t;
}

/** `deploys.events`: replay what is buffered, then tail live until it finishes. */
export async function* subscribeDeployEvents(
  ctx: OrgContext,
  deployId: string,
  signal: AbortSignal,
  bus = deployEventBus,
): AsyncIterable<DeployEvent> {
  const queue: DeployEvent[] = [];
  let ended = false;
  let wake: (() => void) | null = null;
  const poke = (): void => {
    wake?.();
    wake = null;
  };
  const off = bus.subscribe(ctx.activeOrgId, deployId, (e) => {
    if (e) queue.push(e);
    else ended = true;
    poke();
  });
  if (!off) throw notFound('deploy', deployId);
  const replay = bus.get(ctx.activeOrgId, deployId);
  const seen = new Set<number>();
  for (const e of replay?.events ?? []) queue.unshift(e);
  queue.sort((a, b) => a.seq - b.seq);
  if (replay?.done) ended = true;
  signal.addEventListener('abort', poke, { once: true });
  try {
    while (!signal.aborted) {
      while (queue.length) {
        const e = queue.shift() as DeployEvent;
        if (seen.has(e.seq)) continue;
        seen.add(e.seq);
        yield e;
      }
      if (ended) break;
      await new Promise<void>((r) => {
        wake = r;
      });
    }
  } finally {
    off();
    signal.removeEventListener('abort', poke);
  }
}
