/**
 * Node disk hygiene worker (launch-blocker #8: nodes must never fill up).
 *
 * Every 10 minutes, for every online node of every org with a connected node
 * (Docker-truth org set: `store.nodeOrg`), decide with the pure `hygieneDue`
 * (`node-hygiene.core.ts`) whether a cleanup pass is due — every 6h, or after
 * 30 min when the disk is above 85% — and run it through the imported
 * `runNodeHygieneAllOrgs` seam from `@swarmy/trpc` (keep set, node-label
 * settings, `node.hygiene` dispatch and the audit row the node's activity
 * shows all live there). The worker only schedules.
 *
 * Steady state = no dispatch until a node is due. The first pass waits out a
 * boot grace so nodes have reconnected (a warm hub), and ticks never overlap.
 * `lastRun` is in-memory (a controller restart re-runs each node once after
 * the grace — harmless, hygiene is idempotent).
 */
import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { runNodeHygieneAllOrgs } from '@swarmy/trpc';
import { hub, store } from '../gateway';
import { hygieneDue } from './node-hygiene.core';

const TICK_MS = 10 * 60_000;
const BOOT_GRACE_MS = 10 * 60_000;

export function startNodeHygiene(): () => void {
  const lastRun = new Map<string, number>();
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const now = Date.now();
      const due = new Map<string, Set<string>>(); // orgId → nodeIds
      for (const [nodeId, orgId] of store.nodeOrg) {
        if (!hub.isOnline(nodeId)) continue;
        const stats = hub.latestNodeStats(nodeId);
        if (
          !hygieneDue({
            lastRunMs: lastRun.get(nodeId),
            diskUsedBytes: stats?.fsUsedBytes,
            diskTotalBytes: stats?.fsTotalBytes,
            now,
          })
        ) {
          continue;
        }
        let set = due.get(orgId);
        if (!set) due.set(orgId, (set = new Set()));
        set.add(nodeId);
      }
      if (due.size === 0) return;
      const outcomes = await runNodeHygieneAllOrgs(
        { db: prisma, hub, auth: authRegistry.getAuth() },
        due.keys(),
        (orgId, nodeId) => due.get(orgId)?.has(nodeId) ?? false,
      );
      for (const o of outcomes) {
        // Offline/disabled nodes are re-checked next tick; everything else waits its interval.
        if (o.skipped !== 'offline') lastRun.set(o.nodeId, Date.now());
      }
    } catch {
      // never let one tick kill the loop
    } finally {
      running = false;
    }
  };

  const kickoff = setTimeout(() => void tick(), BOOT_GRACE_MS);
  const timer = setInterval(() => void tick(), TICK_MS);
  return () => {
    clearTimeout(kickoff);
    clearInterval(timer);
  };
}
