import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { detectDrift, listAppBindingIds, pollApp, systemContext } from '@swarmy/trpc';
import { hub, store } from '../gateway';

/**
 * git-apps reconcile worker (Phase 3).
 *
 * Every 2 min, per org: POLL each swarmy.yaml app's deploy branches (the
 * production branch + its `environments:` branches) through the provider API
 * and plan any head it hasn't seen — the fallback for controllers GitHub /
 * GitLab can't reach, and for a missed webhook. Idempotent with webhooks (a
 * sha that already has a plan is skipped).
 *
 * Every 10 min: DRIFT — re-plan each environment's last applied commit
 * against live state without applying; a non-empty plan fires `app-drift`
 * once per distinct drift (never silently reverted: git owns the file, a
 * human decides).
 *
 * `SWARMY_GIT_POLL=false` turns polling off (webhooks only); drift stays on.
 */

const TICK_MS = 2 * 60 * 1000;
const DRIFT_EVERY_TICKS = 5;
const BOOT_DELAY_MS = 60_000;

let tick = 0;
let running = false;

async function sweep(): Promise<void> {
  if (running) return; // a long apply must not stack sweeps
  running = true;
  try {
    tick += 1;
    const poll = process.env.SWARMY_GIT_POLL !== 'false';
    const drift = tick % DRIFT_EVERY_TICKS === 0;
    const deps = { db: prisma, hub, auth: authRegistry.getAuth() };
    for (const orgId of new Set(store.nodeOrg.values())) {
      const ctx = systemContext(deps, orgId);
      for (const repoId of await listAppBindingIds(prisma, orgId).catch(() => [])) {
        if (poll)
          await pollApp(ctx, repoId).catch((e: unknown) =>
            console.warn(
              `[app-reconcile] poll ${repoId}: ${e instanceof Error ? e.message : String(e)}`,
            ),
          );
        if (drift) await detectDrift(ctx, repoId).catch(() => undefined);
      }
    }
  } finally {
    running = false;
  }
}

export function startAppReconcile(): () => void {
  const boot = setTimeout(() => void sweep().catch(() => undefined), BOOT_DELAY_MS);
  const timer = setInterval(() => void sweep().catch(() => undefined), TICK_MS);
  return () => {
    clearTimeout(boot);
    clearInterval(timer);
  };
}
