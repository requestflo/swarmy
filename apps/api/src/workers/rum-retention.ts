/**
 * RUM replay retention worker. ClickHouse expires analytics rows and the
 * replay index by per-row TTL (each app's `retentionDays`); the replay chunks
 * in object storage are deleted here, one expired UTC-day prefix at a time.
 * Hourly: a day prefix outlives its retention by at most an hour.
 */
import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { sweepRumRetentionForOrg, systemContext } from '@swarmy/trpc';
import { hub, store } from '../gateway';

const INTERVAL_MS = 60 * 60 * 1000;

async function tick(): Promise<void> {
  const orgIds = [...new Set(store.nodeOrg.values())];
  for (const orgId of orgIds) {
    const ctx = systemContext({ db: prisma, hub, auth: authRegistry.getAuth() }, orgId);
    const r = await sweepRumRetentionForOrg(ctx).catch((e: unknown) => {
      console.warn(`[rum-retention] org ${orgId}: ${(e as Error).message}`);
      return null;
    });
    if (r && r.objectsDeleted > 0) {
      console.log(`[rum-retention] org ${orgId}: removed ${r.objectsDeleted} replay chunks across ${r.daysDeleted} expired days`);
    }
  }
}

export function startRumRetention(): () => void {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    void tick().finally(() => {
      running = false;
    });
  };
  const first = setTimeout(run, 5 * 60 * 1000);
  const timer = setInterval(run, INTERVAL_MS);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
