/**
 * "Pick a server" for a blueprint deploy (owner decision Q3, 2026-09-26):
 * `params.node` pins the app to one Ready server of the org.
 *
 *   - {@link resolvePlacementNode} — the seam: the node must be this org's
 *     and Ready (online, active in the swarm, not draining); returns its swarm
 *     node id, or a plain error.
 *   - {@link pinPlanSteps} — PURE: every service in the plan's compose gets
 *     `node.id==<swarm id>` (replacing any node pin it had, so a volume pin
 *     and the chosen server can never disagree). Managed data (Postgres,
 *     caches) follows the same pin in the executor unless it already has a
 *     placement of its own; buckets live on the object store and never pin.
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { BlueprintPlacementView } from '@swarmy/core';
import type { OrgContext } from '../../context';
import { commandRejected } from '../../errors';
import { statusOf } from '../node.service';
import type { PlanStep } from './catalog';

const NODE_PIN = /^node\.(id|hostname)\s*==/;

/** `node.id==<swarm id>` — the constraint a pinned deploy renders. */
export function nodeConstraint(swarmNodeId: string): string {
  return `node.id==${swarmNodeId}`;
}

/** PURE: a compose source with every service pinned to `swarmNodeId`. */
export function pinComposeToNode(composeSource: string, swarmNodeId: string): string {
  const doc = (parseYaml(composeSource) ?? {}) as { services?: Record<string, Record<string, unknown>> };
  for (const svc of Object.values(doc.services ?? {})) {
    const deploy = ((svc.deploy ??= {}) as Record<string, unknown>);
    const placement = ((deploy.placement ??= {}) as { constraints?: string[] });
    const keep = (placement.constraints ?? []).filter((c) => !NODE_PIN.test(c));
    placement.constraints = [...keep, nodeConstraint(swarmNodeId)];
  }
  return stringifyYaml(doc);
}

/** PURE: the plan with its stack pinned; data steps are pinned by the executor. */
export function pinPlanSteps(steps: PlanStep[], swarmNodeId: string): PlanStep[] {
  return steps.map((s) =>
    s.kind === 'stack.deploy'
      ? { ...s, payload: { ...s.payload, composeSource: pinComposeToNode(s.payload.composeSource, swarmNodeId), placement: nodeConstraint(swarmNodeId) } }
      : s,
  );
}

export interface ResolvedPlacement extends BlueprintPlacementView {
  swarmNodeId: string;
}

/**
 * The server a deploy is pinned to: this org's node, Ready. Anything else is
 * a plain refusal (the id is never looked up outside the org).
 */
export async function resolvePlacementNode(ctx: OrgContext, nodeId: string): Promise<ResolvedPlacement> {
  const row = await ctx.db.node.findFirst({ where: { orgId: ctx.activeOrgId, id: nodeId }, select: { id: true, name: true } });
  if (!row) throw commandRejected(`There's no server "${nodeId}" here. Pick another server, or Automatic.`);
  const online = ctx.hub.isOnline(row.id);
  const status = statusOf(ctx.hub.nodeInfoFor(row.id), online, true, ctx.hub.swarmStateFor(row.id));
  const swarmNodeId = ctx.hub.swarmNodeIdFor(row.id);
  if (status !== 'online' || !swarmNodeId) {
    const why = status === 'online' ? 'hasn’t joined the swarm yet' : `is ${status}`;
    throw commandRejected(`${row.name} ${why}, so nothing can be placed on it. Pick another server, or Automatic.`);
  }
  return { id: row.id, name: row.name, swarmNodeId, constraint: nodeConstraint(swarmNodeId) };
}
