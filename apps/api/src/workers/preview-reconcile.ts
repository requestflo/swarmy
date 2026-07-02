import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { systemContext, type OrgContext } from '@swarmy/trpc';
import { hub, store } from '../gateway';

/**
 * Preview-environment reconcile worker (slice D4 previews).
 *
 * Hourly (TTL granularity is hours), for each org: scan the live inventory for
 * `swarmy.preview.*` stacks and tear down every preview past its TTL
 * (`createdAt + ttlHours`; a `synchronize` deploy refreshes `createdAt`, so the
 * clock counts from the LAST push). Pure Docker-truth — the scan, the TTL
 * selection and the teardown (services + preview-scoped secrets + ingress
 * re-render + audit) are all `previews.service.teardownExpiredPreviews`.
 *
 * ORCHESTRATOR TODO (spine seam missing): add to packages/trpc/src/index.ts
 *   export { teardownExpiredPreviews } from './services/previews.service';
 * …then replace the dynamic seam below with a static root import. Until then
 * the canonical implementation is loaded by file URL — Bun resolves the
 * workspace package by realpath, so module identity is SHARED with the
 * '@swarmy/trpc' graph; a static relative import trips TS6059 (outside this
 * app's rootDir), the same constraint the inbound-hooks receiver documents.
 */

const TICK_MS = 60 * 60 * 1000;
/** One catch-up sweep shortly after boot so restarts never skip a due teardown. */
const BOOT_DELAY_MS = 90_000;

/** Signature mirror of previews.service.ts — keep in sync (D4). */
interface PreviewsSeam {
  teardownExpiredPreviews(ctx: OrgContext): Promise<{ checked: number; tornDown: string[] }>;
}

let previewsSeamPromise: Promise<PreviewsSeam> | null = null;

function previewsSeam(): Promise<PreviewsSeam> {
  previewsSeamPromise ??= import(
    new URL('../../../../packages/trpc/src/services/previews.service.ts', import.meta.url).href
  ) as Promise<PreviewsSeam>;
  return previewsSeamPromise;
}

async function sweep(): Promise<void> {
  const seam = await previewsSeam().catch(() => null);
  if (!seam) return;
  const orgIds = new Set(store.nodeOrg.values());
  for (const orgId of orgIds) {
    // SYSTEM principal per org — teardown audits as `actorType: system`.
    const ctx = systemContext({ db: prisma, hub, auth: authRegistry.getAuth() }, orgId);
    await seam.teardownExpiredPreviews(ctx).catch(() => undefined);
  }
}

export function startPreviewReconcile(): () => void {
  const boot = setTimeout(() => void sweep().catch(() => undefined), BOOT_DELAY_MS);
  const timer = setInterval(() => void sweep().catch(() => undefined), TICK_MS);
  return () => {
    clearTimeout(boot);
    clearInterval(timer);
  };
}
