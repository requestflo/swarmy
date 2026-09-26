import { prisma, telemetry } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { flushTrafficRollups, pruneTrafficRollups, systemContext } from '@swarmy/trpc';
import { TRAFFIC_ROLLUP_MS, rollupWindow } from '@swarmy/core';
import { hub, store } from '../gateway';

/**
 * Per-edge request counting (Q4) — rollup scheduler. Every minute, per org
 * in the in-memory ring, flush the 5-minute buckets that have completed (plus
 * a 30 s grace for late samples) into `EdgeTrafficRollup` (telemetry.db),
 * then advance that org's watermark. Hourly, prune rollups older than 7 days
 * and trim the ring. The maths (`rollupRing`, `rollupWindow`) is pure in
 * @swarmy/core and the write is `flushTrafficRollups` in @swarmy/trpc — this
 * file only ticks.
 *
 * Watermarks live in memory and start at the boot bucket: the bucket a
 * previous process was in when it stopped was never flushed (it had not
 * completed), so nothing is written twice; upserts make it safe regardless.
 */
const TICK_MS = 60_000;
const PRUNE_EVERY_TICKS = 60;

export function startEdgeTrafficRollups(): () => void {
  const bootBucket = Math.floor(Date.now() / TRAFFIC_ROLLUP_MS) * TRAFFIC_ROLLUP_MS;
  const watermark = new Map<string, number>();
  let running = false;
  let tick = 0;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      const now = Date.now();
      for (const orgId of store.edgeTraffic.orgIds()) {
        const window = rollupWindow(watermark.get(orgId) ?? bootBucket, now);
        if (!window) continue;
        try {
          const ctx = systemContext({ db: prisma, hub, auth: authRegistry.getAuth() }, orgId);
          await flushTrafficRollups(ctx, store.edgeTraffic, window);
          watermark.set(orgId, window.to);
        } catch {
          // telemetry.db hiccup: keep the watermark, retry next tick (the ring holds 6 h).
        }
      }
      if (++tick % PRUNE_EVERY_TICKS === 1) {
        store.edgeTraffic.prune(now);
        await pruneTrafficRollups(telemetry, now).catch(() => undefined);
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void run(), TICK_MS);
  return () => clearInterval(timer);
}
