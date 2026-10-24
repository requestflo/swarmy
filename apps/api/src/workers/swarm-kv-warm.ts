/**
 * swarm-kv boot warm-up (plans/epic-docker-native-state.md §2b).
 *
 * Loads each org's swarm-kv documents into the controller's cache as soon as
 * that org's manager agent is connected, so the first request or reconciler
 * tick doesn't pay for the load, and a document that can't be opened is in
 * the startup log with its name instead of surfacing as a failed request.
 * Fast passes while agents dial in after boot, then a slow pass that picks up
 * orgs enrolled later. After each pass it logs documents nearing their size
 * limits (75% of 64 KB per document, of the 2 MB footprint), once per change.
 * The logic (and its tests) is `createKvWarmer` / `createKvSizeWatch` in
 * `@swarmy/trpc`.
 */
import { prisma } from '@swarmy/db';
import { createKvSizeWatch, createKvWarmer } from '@swarmy/trpc';
import { hub } from '../gateway';

const FAST_MS = 2_000;
const FAST_FOR_MS = 2 * 60_000;
const SLOW_MS = 30_000;

export function startSwarmKvWarm(): () => void {
  const warmer = createKvWarmer({ hub, db: prisma });
  const sizes = createKvSizeWatch({ hub, db: prisma });
  const started = Date.now();
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      await warmer.tick();
      await sizes.tick();
    } catch (err) {
      console.error('[swarm-kv] warm-up pass failed:', err);
    } finally {
      running = false;
      if (!stopped) timer = setTimeout(() => void tick(), Date.now() - started < FAST_FOR_MS ? FAST_MS : SLOW_MS);
    }
  };
  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
