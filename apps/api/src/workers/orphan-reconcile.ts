import { prisma } from '@swarmy/db';
import { reconcileOrphanedWork } from '@swarmy/trpc';

/**
 * Once, when this controller becomes the writer: builds and app plans the
 * previous controller process was driving (created before this process
 * started) can never complete, so they are failed with a clear reason and
 * become retryable. See `build-orphans.service.ts`.
 */
const BOOT_AT = new Date(Date.now() - 1_000);

export function startOrphanReconcile(): () => void {
  const t = setTimeout(() => {
    void reconcileOrphanedWork(prisma, BOOT_AT)
      .then((r) => {
        if (r.builds.length || r.plans.length) {
          console.log(`[orphans] failed ${r.builds.length} interrupted build(s) and ${r.plans.length} plan(s) left by the previous controller`);
        }
      })
      .catch((e) => console.error('[orphans] reconcile failed:', e instanceof Error ? e.message : e));
  }, 5_000);
  return () => clearTimeout(t);
}
