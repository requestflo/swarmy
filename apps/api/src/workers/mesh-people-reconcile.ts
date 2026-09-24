/**
 * Self-hosted mesh reconcile (plans/epic-self-hosted-mesh-and-fleets.md M1/M2),
 * every 30 s per org whose mesh control plane runs in swarmy:
 *   1. the control plane itself (bootstrap policies, swarmy connector,
 *      localAuthDisabled, Litestream key, config on the hosting node)
 *   2. people access (ABAC mesh.connect + personal grants → NetBird groups,
 *      Networks, policies, zones, users; routers up/down; expired grants swept)
 *
 * ALL logic lives in @swarmy/trpc (mesh-control.service / mesh-people.service)
 * and @swarmy/mesh (pure renderers + the NetBird diff) — this is a scheduler
 * (reconcile-workers skill). A revoke also converges on the spot, so revocation
 * doesn't wait for a tick.
 */
import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { meshConfigRepo, reconcileMeshControl, reconcilePeopleAccess, systemContext } from '@swarmy/trpc';
import { hub } from '../gateway';

const TICK_MS = 30_000;

export function startMeshPeopleReconcile(): () => void {
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const configs = await meshConfigRepo.listAll({ db: prisma, hub });
      for (const cfg of configs) {
        const mode = (cfg.controlPlane as { mode?: string } | null)?.mode;
        if (!cfg.enabled || mode !== 'managed-by-swarmy') continue;
        const ctx = systemContext({ db: prisma, hub, auth: authRegistry.getAuth() }, cfg.orgId);
        try {
          const c = await reconcileMeshControl(ctx);
          for (const s of c.steps) console.log(`[mesh-reconcile] org=${cfg.orgId} control: ${s}`);
          const p = await reconcilePeopleAccess(ctx);
          if (p.changes.length || p.steps.length) {
            console.log(
              `[mesh-reconcile] org=${cfg.orgId} people: ${p.changes.length} change(s)` +
                (p.steps.length ? `; ${p.steps.join('; ')}` : ''),
            );
          }
          for (const [stack, why] of Object.entries(p.problems)) console.warn(`[mesh-reconcile] org=${cfg.orgId} stack ${stack}: ${why}`);
        } catch (err) {
          console.error(`[mesh-reconcile] org=${cfg.orgId} failed:`, err instanceof Error ? err.message : err);
        }
      }
    } catch (err) {
      console.error('[mesh-reconcile] tick failed:', err instanceof Error ? err.message : err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void run(), TICK_MS);
  void run();
  return () => clearInterval(timer);
}
