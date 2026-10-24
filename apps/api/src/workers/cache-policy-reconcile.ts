import {
  CACHE_APPLIED_POLICY_LABEL,
  POLICY_APPLIED_MARKER,
  encodeCachePolicy,
  planCachePolicy,
  policyApplyScript,
  type CachePolicy,
  type CachePolicyStep,
  type LivePolicySample,
} from '@swarmy/trpc';
import type { ContainerInfo, SwarmServiceInfo } from '@swarmy/core/protocol';
import { hub } from '../gateway';

/**
 * cache-reconcile step (6): converge each data member's when-full +
 * persistence policy to the declared `swarmy.cache.evictionPolicy|persistence`
 * labels. The decision is the pure `planCachePolicy` (@swarmy/trpc
 * cache-policy-plan), gated on the member's `swarmy.cache.appliedPolicy` stamp
 * (+ the primary's live INFO), so a steady cluster sends nothing.
 *
 * Apply = `policyApplyScript` exec'd in EVERY running task of the member
 * (CONFIG SET, then wait for the AOF rewrite / BGSAVE to land); only when all
 * of them print the marker is the applied label stamped — a member with no
 * running task is retried next tick, never stamped blind (its restart would
 * then use a policy whose data was never written in that format). A member
 * built before policies were settable is then rebuilt once (`rebuild`), since
 * its args hard-code the old policy.
 */

const APPLY_TIMEOUT_MS = 90_000;
const SWARM_SERVICE_ID_LABEL = 'com.docker.swarm.service.id';

/** Every running container of the service, with the node hosting it. */
function runningTasks(orgId: string, service: SwarmServiceInfo): Array<{ nodeId: string; containerId: string }> {
  const orgContainerIds = new Set(hub.liveInventory(orgId).containers.map((cc) => cc.id));
  const out: Array<{ nodeId: string; containerId: string }> = [];
  for (const nodeId of hub.onlineNodeIds()) {
    for (const cc of hub.latestContainers(nodeId) as ContainerInfo[]) {
      const sid = cc.serviceId ?? cc.labels?.[SWARM_SERVICE_ID_LABEL];
      if (orgContainerIds.has(cc.id) && sid === service.id && cc.state === 'running') {
        out.push({ nodeId, containerId: cc.id });
      }
    }
  }
  return out;
}

/** CONFIG SET + persist-wait in every running task; true only when all landed. */
async function applyLive(orgId: string, member: SwarmServiceInfo, engine: 'valkey' | 'redis', target: CachePolicy): Promise<boolean> {
  const tasks = runningTasks(orgId, member);
  if (tasks.length === 0) return false;
  const script = policyApplyScript(engine, target);
  for (const t of tasks) {
    const res = await hub
      .dispatch<{ exitCode: number; output?: string }>(
        t.nodeId,
        'exec',
        { target: { containerId: t.containerId }, cmd: ['sh', '-c', script], tty: false, stream: false },
        { timeoutMs: APPLY_TIMEOUT_MS },
      )
      .catch(() => null);
    if (!res || res.exitCode !== 0 || !(res.output ?? '').includes(POLICY_APPLIED_MARKER)) return false;
  }
  return true;
}

export interface PolicyMember {
  service: SwarmServiceInfo;
  /** The INFO-derived live policy (the primary only; null when not sampled). */
  live?: LivePolicySample | null;
  /** Rebuild this member with `target` as its applied policy (legacy members). */
  rebuild: (target: CachePolicy) => Promise<void>;
  /** False when a rebuild is not possible this tick (an unpinned primary): a legacy member then waits. */
  canRebuild?: boolean;
}

/** Converge one cluster's data members. Returns the members it acted on. */
export async function convergeCachePolicy(input: {
  orgId: string;
  managerNode: string;
  engine: 'valkey' | 'redis';
  purpose?: 'cache' | 'queue';
  anchorLabels: Record<string, string>;
  members: PolicyMember[];
}): Promise<string[]> {
  const acted: string[] = [];
  for (const m of input.members) {
    const step: CachePolicyStep = planCachePolicy({
      labels: m.service.labels,
      env: m.service.env,
      anchorLabels: input.anchorLabels,
      ...(input.purpose ? { purpose: input.purpose } : {}),
      live: m.live ?? null,
    });
    if (step.kind === 'none') continue;
    if (step.rebuild && m.canRebuild === false) continue;
    if (!(await applyLive(input.orgId, m.service, input.engine, step.target))) continue;
    acted.push(m.service.name);
    if (step.rebuild) {
      await m.rebuild(step.target);
    } else if (m.service.labels[CACHE_APPLIED_POLICY_LABEL] !== encodeCachePolicy(step.target)) {
      await hub
        .dispatch(input.managerNode, 'service.updateLabels', {
          service: m.service.name,
          add: { [CACHE_APPLIED_POLICY_LABEL]: encodeCachePolicy(step.target) },
          removeKeys: [],
        })
        .catch(() => undefined);
    }
  }
  return acted;
}
