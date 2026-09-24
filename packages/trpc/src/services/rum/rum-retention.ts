/**
 * Replay chunk retention in object storage. ClickHouse drops analytics rows
 * and the replay index itself (per-row TTL); the chunks in Garage are deleted
 * here, a whole UTC day prefix at a time, once it is older than the app's
 * retention. An app that no longer exists keeps the default retention.
 */
import { buildInventory } from '@swarmy/core';
import { RUM_SETTINGS_LABEL, defaultRumSettings, deletePrefix, expiredDays, readRumSettings, replayOrgPrefix, type BlobStore } from '@swarmy/rum';
import type { OrgContext } from '../../context';
import { rumBlobStore } from './rum-store';

export interface RetentionSweepResult {
  apps: number;
  daysDeleted: number;
  objectsDeleted: number;
}

/** Pure core: sweep one org's prefixes given a store and per-app retention. */
export async function sweepReplayChunks(
  store: BlobStore,
  orgId: string,
  retentionFor: (app: string) => number,
  now: Date,
): Promise<RetentionSweepResult> {
  const orgPrefix = replayOrgPrefix(orgId);
  const { prefixes: appPrefixes } = await store.list(orgPrefix, '/');
  const out: RetentionSweepResult = { apps: 0, daysDeleted: 0, objectsDeleted: 0 };
  for (const ap of appPrefixes) {
    const app = decodeURIComponent(ap.slice(orgPrefix.length).replace(/\/$/, ''));
    out.apps++;
    const { prefixes: dayPrefixes } = await store.list(ap, '/');
    const days = dayPrefixes.map((p) => p.slice(ap.length).replace(/\/$/, ''));
    for (const day of expiredDays(days, retentionFor(app), now)) {
      out.objectsDeleted += await deletePrefix(store, `${ap}${day}/`);
      out.daysDeleted++;
    }
  }
  return out;
}

export async function sweepRumRetentionForOrg(ctx: OrgContext, now = new Date()): Promise<RetentionSweepResult | null> {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  const live = buildInventory(services, containers).services.filter((s) => s.labels[RUM_SETTINGS_LABEL]);
  const byApp = new Map<string, number>();
  for (const s of live) byApp.set(s.stack, readRumSettings(s.labels).retentionDays);
  // Nothing configured anywhere and never provisioned ⇒ nothing to sweep (and no provisioning).
  if (byApp.size === 0 && !process.env.SWARMY_RUM_S3_ENDPOINT) {
    return null;
  }
  const store = await rumBlobStore(ctx).catch(() => null);
  if (!store) return null;
  const fallback = defaultRumSettings().retentionDays;
  return sweepReplayChunks(store, ctx.activeOrgId, (app) => byApp.get(app) ?? fallback, now);
}
