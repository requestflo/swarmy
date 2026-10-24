/**
 * Personal mesh grant TTL sweeper (plans/epic-self-hosted-mesh-and-fleets.md
 * §3.2, M3), every 30 s: for each org with an expired personal grant
 * (`MeshRoute` kind=person, `expiresAt` ≤ now), revoke it through the same
 * path as a person pressing Revoke — row gone, `mesh.access.revoke` audited
 * as the system actor with reason=expired — then converge NetBird once so
 * the grant's group, policy and DNS go with it.
 *
 * Org source is the DB (invariant #4: grants are swarmy's own access control),
 * so an org whose mesh is off still loses stale grants. ALL logic lives in
 * @swarmy/trpc (`sweepExpiredPersonGrants`) and @swarmy/mesh (`planGrantSweep`,
 * pure); this is a scheduler (reconcile-workers skill). Steady state (nothing
 * expired) is one indexed read and zero writes or dispatches.
 */
import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { orgsWithExpiredGrants, sweepExpiredPersonGrants, systemContext } from '@swarmy/trpc';
import { hub } from '../gateway';

const TICK_MS = 30_000;
/** The converge brings stack routers up/down: let nodes reconnect after a restart first. */
const FIRST_RUN_MS = 15_000;

export function startMeshGrantTtl(): () => void {
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      for (const orgId of await orgsWithExpiredGrants(prisma)) {
        const ctx = systemContext({ db: prisma, hub, auth: authRegistry.getAuth() }, orgId);
        try {
          const r = await sweepExpiredPersonGrants(ctx);
          if (r.revoked.length) {
            console.log(
              `[mesh-grant-ttl] org=${orgId} revoked ${r.revoked.length} expired grant(s)` + (r.converged ? '; mesh converged' : ''),
            );
          }
        } catch (err) {
          console.error(`[mesh-grant-ttl] org=${orgId} failed:`, err instanceof Error ? err.message : err);
        }
      }
    } catch (err) {
      console.error('[mesh-grant-ttl] tick failed:', err instanceof Error ? err.message : err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void run(), TICK_MS);
  const kickoff = setTimeout(() => void run(), FIRST_RUN_MS);
  return () => {
    clearInterval(timer);
    clearTimeout(kickoff);
  };
}
