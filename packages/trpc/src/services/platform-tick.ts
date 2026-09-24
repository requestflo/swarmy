/**
 * The platform-upgrade worker tick (apps/api `platform-upgrade` worker):
 *
 *  - resume: re-drive every `running` run this process isn't driving — after a
 *    controller restart, including the one the controller step causes;
 *  - feed (when `checkFeeds`, every 6 h): fetch + verify each org's channel
 *    release (one fetch per feed URL per tick);
 *  - auto-apply: a verified PATCH release, auto-apply on, inside the window,
 *    nothing running, and the same target didn't already fail automatically →
 *    start a run (trigger `auto`). Majors/minors always wait for an admin.
 */
import type { DB } from '@swarmy/db';
import type { OrgContext } from '../context';
import {
  checkFeed,
  currentManifestOf,
  fetchFeedText,
  policyOf,
  shouldAutoApply,
  type AvailableRelease,
  type FetchText,
} from './platform-release.service';
import { defaultDeps, resumePlatformUpgrades, startPlatformUpgrade, type PlatformUpgradeDeps } from './platform-upgrade.service';

export interface PlatformTickResult {
  resumed: number;
  checked: number;
  started: string[];
}

export async function platformTick(
  ctxFor: (orgId: string) => OrgContext,
  db: DB,
  opts: { checkFeeds?: boolean; autoApply?: boolean; now?: Date; fetchText?: FetchText; deps?: PlatformUpgradeDeps } = {},
): Promise<PlatformTickResult> {
  const deps = opts.deps ?? defaultDeps;
  const out: PlatformTickResult = { resumed: 0, checked: 0, started: [] };
  out.resumed = await resumePlatformUpgrades(ctxFor, db, deps).catch(() => 0);
  if (!opts.checkFeeds && !opts.autoApply) return out;

  const orgs = await db.organization.findMany({ where: { nodes: { some: {} } }, select: { id: true } });
  // One fetch per feed URL per tick, however many orgs share it.
  const memo = new Map<string, Promise<string>>();
  const fetchText = opts.fetchText ?? fetchFeedText;
  const fetchMemo: FetchText = (url) => {
    if (!memo.has(url)) memo.set(url, fetchText(url));
    return memo.get(url)!;
  };

  for (const { id: orgId } of orgs) {
    const ctx = ctxFor(orgId);
    try {
      if (opts.checkFeeds) {
        await checkFeed(ctx, fetchMemo);
        out.checked++;
      }
      if (!opts.autoApply) continue;
      const row = await db.platformConfig.findUnique({ where: { orgId } });
      if (!row?.autoApplyPatches) continue;
      const [running, lastAuto] = await Promise.all([
        db.platformUpgradeRun.findFirst({ where: { orgId, status: 'running' }, select: { id: true } }),
        db.platformUpgradeRun.findFirst({
          where: { orgId, trigger: 'auto' },
          orderBy: { startedAt: 'desc' },
          select: { status: true, toVersion: true },
        }),
      ]);
      const decision = shouldAutoApply({
        policy: policyOf(row),
        current: currentManifestOf(row).version,
        available: (row.available as AvailableRelease | null) ?? null,
        running: Boolean(running),
        lastFailedTarget: lastAuto && lastAuto.status !== 'done' && lastAuto.status !== 'running' ? lastAuto.toVersion : null,
        now: opts.now ?? new Date(),
      });
      if (!decision.go) continue;
      await startPlatformUpgrade(ctx, { trigger: 'auto', version: decision.version }, deps);
      out.started.push(orgId);
    } catch (e) {
      console.warn(`[platform-upgrade] org ${orgId}:`, e instanceof Error ? e.message : e);
    }
  }
  return out;
}
