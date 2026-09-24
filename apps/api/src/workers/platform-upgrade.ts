/**
 * Platform upgrades worker (plans/epic-platform-upgrades.md).
 *
 *  - every 30 s: resume any `running` PlatformUpgradeRun this process isn't
 *    driving. This is how a run survives the controller replacing ITSELF: the
 *    new controller boots, this tick finds the run on its controller step and
 *    carries on (first tick after a short warm-up so agents have reconnected
 *    and the hub has live inventory);
 *  - every 5 min: auto-apply a verified PATCH release inside the org's
 *    maintenance window (opt-in);
 *  - at boot + every 6 h: check each org's channel feed and verify it offline
 *    against the swarmy release key.
 */
import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
// Namespace import: until the integration pass exports `platformTick` from
// @swarmy/trpc's index, a named import would fail module linking and take the
// whole controller down; this way the worker just stays idle.
import * as trpc from '@swarmy/trpc';
import { hub } from '../gateway';

const TICK_MS = 30_000;
const AUTO_APPLY_EVERY_MS = 5 * 60_000;
const FEED_EVERY_MS = 6 * 60 * 60_000;
const WARMUP_MS = 45_000;

export function startPlatformUpgradeWorker(): () => void {
  let running = false;
  let lastAuto = 0;
  let lastFeed = 0;
  const { platformTick, systemContext } = trpc;
  if (typeof platformTick !== 'function') {
    console.warn('[platform-upgrade] platformTick not exported by @swarmy/trpc — worker idle');
    return () => undefined;
  }
  const ctxFor = (orgId: string) => systemContext({ db: prisma, hub, auth: authRegistry.getAuth() }, orgId);
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const now = Date.now();
      const checkFeeds = now - lastFeed >= FEED_EVERY_MS;
      const autoApply = now - lastAuto >= AUTO_APPLY_EVERY_MS;
      const r = await platformTick(ctxFor, prisma as never, { checkFeeds, autoApply });
      if (checkFeeds) lastFeed = now;
      if (autoApply) lastAuto = now;
      if (r.started.length) console.log(`[platform-upgrade] auto-applied a patch release for ${r.started.length} org(s)`);
    } catch (e) {
      console.warn('[platform-upgrade] tick failed:', e instanceof Error ? e.message : e);
    } finally {
      running = false;
    }
  };
  const kickoff = setTimeout(() => void tick(), WARMUP_MS);
  const timer = setInterval(() => void tick(), TICK_MS);
  return () => {
    clearTimeout(kickoff);
    clearInterval(timer);
  };
}
