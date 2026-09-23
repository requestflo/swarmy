import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { resumeRunningMigrations, systemContext } from '@swarmy/trpc';
import { hub } from '../gateway';

/**
 * Swarm-over-mesh migration resumer. A run is kicked in-process by the
 * `mesh.migrateSwarm` / `mesh.resumeMigration` mutations; this tick only picks
 * up runs persisted as `running` with no live runner — i.e. after a
 * controller restart mid-move (the node the controller runs on may itself be
 * the one moving). The runner's per-org lock makes the overlap harmless.
 */
const TICK_MS = 30_000;

export function startMeshMigrationResumer(): () => void {
  const tick = (): void => {
    void resumeRunningMigrations(
      (orgId) => systemContext({ db: prisma, hub, auth: authRegistry.getAuth() }, orgId),
      prisma as never,
    ).catch((e) => console.warn('[mesh-migration] resume tick failed:', e instanceof Error ? e.message : e));
  };
  const timer = setInterval(tick, TICK_MS);
  return () => clearInterval(timer);
}
