import type { DB } from '@swarmy/db';
import {
  WATERMARK_RUN_KIND,
  forgetWatermark,
  parsePersistedWatermarks,
  recordWatermark,
  type PersistedWatermark,
  type PersistedWatermarks,
} from './manageddb-watermark.core';

/**
 * The failover-watermark store: one `OperationRun` row per org
 * (`kind = db.failoverWatermark`) in the controller store, cached in memory.
 * The rules (what a stored sample may prove) are in manageddb-watermark.core.
 *
 * Load once per org on its first tick after boot; record each healthy-tick
 * sample; flush once per tick when something changed. Every DB failure is
 * swallowed: a missing or unreadable row is "nothing stored" ⇒ the failover
 * decision sees an unknown watermark and holds — the safe default.
 */

type RunsDb = Pick<DB, 'operationRun'>;

export interface WatermarkStore {
  /** Load the org's stored map (cached after the first successful read). */
  load(orgId: string): Promise<void>;
  get(orgId: string, cluster: string): PersistedWatermark | undefined;
  record(orgId: string, cluster: string, sample: PersistedWatermark): void;
  forget(orgId: string, cluster: string): void;
  /** Write the org's map back when it changed this tick. */
  flush(orgId: string): Promise<void>;
}

export function createWatermarkStore(db: RunsDb): WatermarkStore {
  const maps = new Map<string, PersistedWatermarks>();
  const dirty = new Set<string>();
  return {
    async load(orgId) {
      if (maps.has(orgId)) return;
      try {
        const row = await db.operationRun.findUnique({
          where: { orgId_kind: { orgId, kind: WATERMARK_RUN_KIND } },
        });
        maps.set(orgId, parsePersistedWatermarks(row?.run));
      } catch {
        // Unreadable ⇒ nothing stored this tick; retried next tick.
      }
    },
    get(orgId, cluster) {
      return maps.get(orgId)?.[cluster];
    },
    record(orgId, cluster, sample) {
      maps.set(orgId, recordWatermark(maps.get(orgId) ?? {}, cluster, sample));
      dirty.add(orgId);
    },
    forget(orgId, cluster) {
      const prev = maps.get(orgId);
      if (!prev || !(cluster in prev)) return;
      maps.set(orgId, forgetWatermark(prev, cluster));
      dirty.add(orgId);
    },
    async flush(orgId) {
      if (!dirty.delete(orgId)) return;
      const run = (maps.get(orgId) ?? {}) as unknown as object;
      try {
        await db.operationRun.upsert({
          where: { orgId_kind: { orgId, kind: WATERMARK_RUN_KIND } },
          create: { orgId, kind: WATERMARK_RUN_KIND, run },
          update: { run },
        });
      } catch {
        // Best-effort: the next healthy tick writes a fresher sample anyway.
      }
    },
  };
}
