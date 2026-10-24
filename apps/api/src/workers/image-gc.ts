/**
 * Image GC worker (epic: git-cicd-registry, PHASE-2).
 *
 * Periodically enforces each org's `ImageGcPolicy`:
 *  - ON_HEALTHCHECK: after a new image is live, prune older non-prod images.
 *  - AGE_DAYS: prune images older than N days — EXCEPT any digest currently
 *    running in prod (the pinned set), which is never collected.
 *  - KEEP_LAST: keep each repo's newest N builds, plus anything in prod.
 *
 * Then the registry-side pass (`runRegistryGcAllOrgs`): delete the manifests
 * the plan selected + untagged leftovers through the registry API, and run
 * `registry garbage-collect` in a read-only window. Signature-gated per org —
 * this worker holds the last signature; an unchanged plan sends no mutations.
 *
 * The decision is computed controller-side (`runImageGcAllOrgs` →
 * `computeGcPlan`); the actions are dispatched as `image.prune` commands. Sits
 * beside `startRetention` in the worker registry.
 *
 * NOTE: the epic doc names this `apps/api/workers/image-gc.ts`; it lives under
 * `src/workers/` to match the existing worker layout + `./image-gc` import in
 * workers/index.ts (INTEGRATION snippet).
 */
import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { runImageGcAllOrgs, runRegistryGcAllOrgs, type RegistryGcState } from '@swarmy/trpc';
import { hub } from '../gateway';

/** GC cadence — conservative; prod pins guarantee correctness regardless. */
const GC_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6h

export function startImageGc(): () => void {
  const registryState = new Map<string, RegistryGcState>();
  let running = false;
  const run = async () => {
    if (running) return; // a registry window can outlast a tick; never overlap
    running = true;
    try {
      const deps = { db: prisma, hub, auth: authRegistry.getAuth() };
      await runImageGcAllOrgs(deps).catch(() => undefined);
      await runRegistryGcAllOrgs(deps, registryState).catch(() => undefined);
    } finally {
      running = false;
    }
  };
  // Defer the first run so the gateway/hub is warm and nodes have reconnected.
  const kickoff = setTimeout(run, 5 * 60 * 1000);
  const timer = setInterval(run, GC_INTERVAL_MS);
  return () => {
    clearTimeout(kickoff);
    clearInterval(timer);
  };
}
