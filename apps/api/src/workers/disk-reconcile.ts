/**
 * Disk re-attach worker (QA-075b).
 *
 * A disk formatted by an older agent was mounted only in the agent's private
 * mount namespace: the host (and dockerd) never saw it, Docker wrote into the
 * bare mountpoint on the ROOT disk, and new stateful workloads on that server
 * are refused. This worker finds such disks and re-attaches them.
 *
 * It checks each node when it comes online (offline → online, and on the
 * first tick after a boot grace) and every {@link RECHECK_MS} after, and only
 * ever acts on disks the node DECLARES in its `swarmy.disk.<id>` labels. All
 * logic (list → stop the apps → `disk.repair` → start the apps → audit) lives
 * in `@swarmy/trpc` `runDiskReconcileFor`; this is a scheduler. A disk whose
 * repair failed is left alone for {@link FAILED_BACKOFF_MS} so its apps are
 * not stopped and started every few minutes. State is in memory: a restart
 * re-checks every node once.
 */
import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { runDiskReconcileFor, systemContext } from '@swarmy/trpc';
import { hub, store } from '../gateway';

const TICK_MS = 30_000;
const RECHECK_MS = 5 * 60_000;
const BOOT_GRACE_MS = 60_000;
const FAILED_BACKOFF_MS = 60 * 60_000;

/** Pure: is this node due a check? Newly online ⇒ now; else every RECHECK_MS. */
export function diskCheckDue(input: { wasOnline: boolean; lastCheckMs: number | undefined; now: number }): boolean {
  if (!input.wasOnline) return true;
  return input.lastCheckMs === undefined || input.now - input.lastCheckMs >= RECHECK_MS;
}

export function startDiskReconcile(): () => void {
  const lastCheck = new Map<string, number>();
  const failedAt = new Map<string, number>(); // `${nodeId}/${serial}` → when its repair last failed
  let online = new Set<string>();
  let running = false;
  const bootAt = Date.now();

  const tick = async (): Promise<void> => {
    // The first pass waits for nodes to reconnect; every node is "newly online" then.
    if (running || Date.now() - bootAt < BOOT_GRACE_MS) return;
    running = true;
    const now = Date.now();
    const nowOnline = new Set<string>();
    try {
      for (const [nodeId, orgId] of store.nodeOrg) {
        if (!hub.isOnline(nodeId)) {
          lastCheck.delete(nodeId);
          continue;
        }
        nowOnline.add(nodeId);
        if (!diskCheckDue({ wasOnline: online.has(nodeId), lastCheckMs: lastCheck.get(nodeId), now })) continue;
        lastCheck.set(nodeId, now);
        try {
          const ctx = systemContext({ db: prisma, hub, auth: authRegistry.getAuth() }, orgId);
          const skip = (serial: string) => now - (failedAt.get(`${nodeId}/${serial}`) ?? -Infinity) < FAILED_BACKOFF_MS;
          const r = await runDiskReconcileFor(ctx, nodeId, skip);
          if ('repaired' in r) {
            for (const serial of r.repaired) console.log(`[disks] node ${nodeId}: re-attached disk ${serial}`);
            for (const f of r.failed) {
              failedAt.set(`${nodeId}/${f.serial}`, Date.now());
              console.warn(`[disks] node ${nodeId}: could not re-attach disk ${f.serial}: ${f.error}`);
            }
          }
        } catch (err) {
          console.warn(`[disks] node ${nodeId}: disk check failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      online = nowOnline;
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), TICK_MS);
  return () => clearInterval(timer);
}
