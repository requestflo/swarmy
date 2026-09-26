/**
 * Controller-side seams for pinning managed data services with node-local
 * volumes (cache / search / vector) to one swarm node. The pure plan lives in
 * `@swarmy/core` (`data-pin.ts`, the generalised form of the managed-Postgres
 * `manageddb-storage` model); this module wires it to the hub:
 *
 *   - {@link chooseDataPin}        — where a NEW data member goes (provision).
 *   - {@link runningTaskSwarmNodes} — where a member's data is RIGHT NOW.
 *   - {@link adoptDataPin}         — pin an unpinned member IN PLACE (inspect →
 *                                    label + `node.id==` → deploy; the task lands
 *                                    back on the node that holds its volume).
 *   - {@link reconcileDataPin}     — one reconcile step (the cache/search/vector
 *                                    workers call it every tick): adopt when it
 *                                    runs on exactly one node, warn — never
 *                                    guess, never redeploy — when it doesn't.
 *   - {@link dataVolumeNode}       — the node backup/restore must run on (the
 *                                    volume is node-local; the manager may not
 *                                    have it — or worse, has an EMPTY one).
 */
import {
  applyDataPin,
  pinnedDataCounts,
  planDataPin,
  type DataPinPlan,
} from '@swarmy/core';
import type { ContainerInfo, ServiceSpec } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import type { AgentHub } from '../hub/types';
import { commandRejected, mapDispatchError } from '../errors';
import { chooseDiskAwarePin } from './disks.service';
import { writeAudit } from './audit.service';
import { fireEvent, type FireEventInput } from './alerts-fire';
import { applyServicePatch, liveServiceSpec, type LiveServiceRef } from './service-patch';

const SWARM_SERVICE_ID_LABEL = 'com.docker.swarm.service.id';
const DISPATCH_TIMEOUT_MS = 60_000;

type TaskHub = Pick<AgentHub, 'liveInventory' | 'onlineNodeIds' | 'latestContainers' | 'swarmNodeIdFor'>;

/** A live data member, as far as pinning cares (InvService / SwarmServiceInfo both fit). */
export interface DataMemberRef extends LiveServiceRef {
  id: string;
  labels: Record<string, string>;
}

/**
 * Swarm node ids hosting the service's RUNNING tasks (org-scoped container
 * scan). An agent whose swarm id is not yet known reports as `undefined`.
 */
export function runningTaskSwarmNodes(
  hub: TaskHub,
  orgId: string,
  serviceId: string,
): (string | undefined)[] {
  const orgContainerIds = new Set(hub.liveInventory(orgId).containers.map((c) => c.id));
  const out: (string | undefined)[] = [];
  for (const nodeId of hub.onlineNodeIds()) {
    const running = hub.latestContainers(nodeId).some((c: ContainerInfo) => {
      if (!orgContainerIds.has(c.id)) return false;
      const sid = c.serviceId ?? c.labels?.[SWARM_SERVICE_ID_LABEL];
      return sid === serviceId && c.state === 'running';
    });
    if (running) out.push(hub.swarmNodeIdFor(nodeId));
  }
  return out;
}

/**
 * The swarm node a NEW data member is pinned to: schedulable nodes hosting the
 * fewest pinned data members of ANY kind (Postgres primaries included), ties to
 * the manager we dispatch through. Undefined only when no node has reported.
 */
export function chooseDataPin(
  ctx: Pick<OrgContext, 'hub' | 'activeOrgId'>,
  managerNodeId: string,
): string | undefined {
  // Skips a node whose declared data disk is not attached (QA-075b).
  return chooseDiskAwarePin(ctx, pinnedDataCounts(ctx.hub.liveInventory(ctx.activeOrgId).services), ctx.hub.swarmNodeIdFor(managerNodeId));
}

/** More than one swarm node ⇒ floating replicas are anti-affine to the pinned member. */
export function isMultiNodeSwarm(ctx: Pick<OrgContext, 'hub' | 'activeOrgId'>): boolean {
  return ctx.hub.nodeInventory(ctx.activeOrgId).length > 1;
}

/**
 * Pin a live member IN PLACE: read its FULL live spec, stamp `pinLabel=<pin>`
 * and merge `node.id==<pin>` (+ one task per node) into its placement, then
 * redeploy. Everything else (mounts, command, secrets, foreign labels) is
 * carried verbatim. Safe because `pin` is where its task — and so its
 * node-local volume — already is: the rescheduled task reattaches the same data.
 */
export async function adoptDataPin(
  ctx: Pick<OrgContext, 'hub'>,
  managerNodeId: string,
  member: LiveServiceRef,
  pinLabel: string,
  pin: string,
): Promise<ServiceSpec> {
  const live = await liveServiceSpec(ctx, managerNodeId, member);
  const spec = applyServicePatch(live, {
    setLabels: { [pinLabel]: pin },
    transform: (s) => applyDataPin(s, { pin, onePerNode: true }),
  });
  try {
    await ctx.hub.dispatch(
      managerNodeId,
      'service.deploy',
      { spec, pullPolicy: 'missing' },
      { timeoutMs: DISPATCH_TIMEOUT_MS },
    );
  } catch (e) {
    throw mapDispatchError(e);
  }
  return spec;
}

export interface DataPinSeams {
  fireEvent: (ctx: OrgContext, input: FireEventInput) => Promise<void>;
  writeAudit: typeof writeAudit;
}
const defaultSeams: DataPinSeams = { fireEvent, writeAudit };

export type DataPinOutcome = DataPinPlan & { adopted?: boolean };

/**
 * One reconcile step for a data member's node pin. Idempotent: a pinned member
 * dispatches nothing. Unpinned + running on exactly one node → adopted in place
 * (audited as the system actor, with an info event naming the node — if the
 * task had ALREADY been rescheduled off its original node, older data may still
 * sit in the same-named volume there). Unpinned and not running (or running on
 * several nodes) → a warning event, deduped per member via `warned`, and NO
 * dispatch — a redeploy could start it on a node with an empty volume.
 */
export async function reconcileDataPin(input: {
  ctx: OrgContext;
  managerNodeId: string;
  member: DataMemberRef;
  pinLabel: string;
  /** Alert resource + audit target, e.g. `cache:hello/main`. */
  resource: string;
  /** Human name for messages, e.g. `Cache hello/main`. */
  title: string;
  volume: string;
  /** Per-worker memory of members already warned about (key = resource). */
  warned: Set<string>;
  seams?: DataPinSeams;
}): Promise<DataPinOutcome> {
  const { ctx, member, resource } = input;
  const seams = input.seams ?? defaultSeams;
  const plan = planDataPin({
    labels: member.labels,
    pinLabel: input.pinLabel,
    runningNodes: runningTaskSwarmNodes(ctx.hub, ctx.activeOrgId, member.id),
  });

  if (plan.kind === 'unplaced') {
    if (!input.warned.has(resource)) {
      input.warned.add(resource);
      await seams
        .fireEvent(ctx, {
          signal: 'data-storage',
          severity: 'warning',
          resource,
          message: `${input.title}: ${plan.message}`,
        })
        .catch(() => undefined);
    }
    return plan;
  }

  if (input.warned.delete(resource)) {
    await seams
      .fireEvent(ctx, {
        signal: 'data-storage',
        severity: 'info',
        resource,
        message: `${input.title}: data volume is pinned to its node`,
        status: 'resolved',
      })
      .catch(() => undefined);
  }
  if (plan.kind === 'pinned') return plan;

  try {
    await adoptDataPin(ctx, input.managerNodeId, member, input.pinLabel, plan.pin);
  } catch {
    return plan; // retried next tick
  }
  await seams
    .writeAudit(ctx, {
      action: 'data.pinNode',
      actorType: 'system',
      targetType: 'service',
      targetId: member.name,
      metadata: { pinNode: plan.pin, volume: input.volume, reason: 'adopt-running-task' },
    })
    .catch(() => undefined);
  await seams
    .fireEvent(ctx, {
      signal: 'data-storage-pinned',
      severity: 'info',
      resource,
      message:
        `${input.title}: pinned to swarm node ${plan.pin} (where its task runs) so a reboot can no longer move it onto an empty volume. ` +
        `If it had already been rescheduled off its original node, older data may remain in volume "${input.volume}" there.`,
    })
    .catch(() => undefined);
  return { ...plan, adopted: true };
}

/**
 * The controller node id whose agent must run a backup/restore of `member`'s
 * node-local volume. Pinned → the pinned node. Unpinned → the node its running
 * task is on (and, with `adopt`, it is pinned there first so the restored data
 * and the restarted task cannot part). Refuses rather than fall back to a
 * manager that may not hold the volume at all.
 */
export async function dataVolumeNode(
  ctx: OrgContext,
  member: DataMemberRef,
  pinLabel: string,
  opts: { adopt?: boolean; managerNodeId?: string } = {},
): Promise<{ nodeId: string; pin: string }> {
  const plan = planDataPin({
    labels: member.labels,
    pinLabel,
    runningNodes: runningTaskSwarmNodes(ctx.hub, ctx.activeOrgId, member.id),
  });
  if (plan.kind === 'unplaced') throw commandRejected(`${member.name} is ${plan.message}`);
  if (plan.kind === 'adopt' && opts.adopt && opts.managerNodeId) {
    await adoptDataPin(ctx, opts.managerNodeId, member, pinLabel, plan.pin);
  }
  const nodeId = ctx.hub.onlineNodeIds().find((id) => ctx.hub.swarmNodeIdFor(id) === plan.pin);
  if (!nodeId) {
    throw commandRejected(
      `the node holding ${member.name}'s data volume (swarm node ${plan.pin}) is offline — bring it back before backing up or restoring`,
    );
  }
  return { nodeId, pin: plan.pin };
}
