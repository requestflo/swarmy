import { selectorMatches } from '@swarmy/core';
import type { AlertRuleView, NotificationChannelView, ReleaseView } from '@swarmy/core';
import { lastGood } from '@/components/app-tabs/releases/release-label';

const HOUR = 3_600_000;

/**
 * Where an instant falls on the issue's 24 h trend, as a 0..1 fraction of the
 * chart width. The trend's buckets are the 23 whole hours before this one plus
 * the current hour (the controller's `trendFor`), so the window ends at the
 * end of the current hour. Null when it falls before the window.
 */
export function trendPosition(iso: string | null, now = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const start = Math.floor(now / HOUR) * HOUR - 23 * HOUR;
  const f = (t - start) / (24 * HOUR);
  if (f < 0) return null;
  return Math.min(1, f);
}

/**
 * The version to put back to — only when the issue came in with the release
 * that is running now (the stack's newest release, still live or rolling out).
 */
export function rollbackTarget(rows: readonly ReleaseView[], introducedReleaseId: string | null): ReleaseView | null {
  const head = rows[0];
  if (!introducedReleaseId || !head || head.id !== introducedReleaseId) return null;
  if (head.status !== 'healthy' && head.status !== 'deploying') return null;
  return lastGood([...rows]) ?? null;
}

/**
 * Who hears about this issue spiking: the enabled `error-spike` rules whose
 * target covers the app, and their channels. Muted rules still record but
 * send nothing, so their channels are left out.
 */
export function spikeChannels(
  rules: readonly AlertRuleView[],
  channels: readonly NotificationChannelView[],
  app: string,
  now = Date.now(),
): { rules: number; channels: NotificationChannelView[] } {
  const live = rules.filter(
    (r) =>
      r.signal === 'error-spike' &&
      r.enabled &&
      selectorMatches(r.selector, { app }) &&
      !(r.mutedUntil && Date.parse(r.mutedUntil) > now),
  );
  const ids = new Set(live.flatMap((r) => r.channelIds));
  return { rules: live.length, channels: channels.filter((c) => ids.has(c.id) && c.enabled) };
}
