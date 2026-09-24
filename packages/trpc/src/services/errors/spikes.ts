/**
 * Spike alerts: one sweep per org per minute (errors-alerts worker). Counts
 * come straight from ClickHouse (last 10 min vs the previous 24 h, per
 * issue); {@link isSpike} decides. A spiking issue raises `error-spike`
 * through `fireEvent` (deduped per issue); when it calms down the alert is
 * resolved. Which issues are currently spiking is process memory — after a
 * restart the next sweep re-derives it (a still-open alert is resolved by the
 * first calm sweep only if it was raised by this process; stale ones age out
 * with the next spike on the same issue).
 */
import type { OrgContext } from '../../context';
import { fireEvent } from '../alerts-fire';
import { isSpike, issueResource, SPIKE_BASELINE_HOURS, SPIKE_MIN_EVENTS, SPIKE_WINDOW_MINUTES } from './lifecycle';
import { buildIssueStateQuery, buildSpikeQuery, type IssueStateRow, type SpikeRow } from './query';
import { errorsStore } from './store';

const spiking = new Map<string, Map<string, { stack: string; title: string }>>();

export async function sweepErrorSpikes(ctx: OrgContext): Promise<{ spiking: number }> {
  const ch = await errorsStore(ctx).catch(() => null);
  if (!ch) return { spiking: 0 };
  const rows = await ch.query<SpikeRow>(
    buildSpikeQuery(ch.database, ctx.activeOrgId, {
      windowMinutes: SPIKE_WINDOW_MINUTES,
      baselineHours: SPIKE_BASELINE_HOURS,
      minRecent: SPIKE_MIN_EVENTS,
    }),
  );
  if (rows === null) return { spiking: spiking.get(ctx.activeOrgId)?.size ?? 0 };

  const candidates = rows.filter((r) => isSpike(Number(r.recent), Number(r.baseline)));
  // Ignored issues never page.
  const ignored = new Set<string>();
  const byProject = new Map<number, string[]>();
  for (const r of candidates) byProject.set(r.project_id, [...(byProject.get(r.project_id) ?? []), r.fingerprint]);
  for (const [pid, fps] of byProject) {
    const states = (await ch.query<IssueStateRow>(buildIssueStateQuery(ch.database, ctx.activeOrgId, pid, fps))) ?? [];
    for (const s of states) if (s.status === 'ignored') ignored.add(s.fingerprint);
  }

  const prev = spiking.get(ctx.activeOrgId) ?? new Map<string, { stack: string; title: string }>();
  const now = new Map<string, { stack: string; title: string }>();
  for (const r of candidates) {
    if (ignored.has(r.fingerprint)) continue;
    const resource = issueResource(r.stack, r.fingerprint);
    now.set(resource, { stack: r.stack, title: r.title });
    if (prev.has(resource)) continue;
    await fireEvent(ctx, {
      signal: 'error-spike',
      severity: 'critical',
      resource,
      message: `Error spike in ${r.stack}: ${r.title} — ${Number(r.recent)} events in ${SPIKE_WINDOW_MINUTES} min`,
    }).catch(() => undefined);
  }
  for (const [resource, v] of prev) {
    if (now.has(resource)) continue;
    await fireEvent(ctx, {
      signal: 'error-spike',
      severity: 'info',
      resource,
      status: 'resolved',
      message: `Error rate for ${v.title} in ${v.stack} is back to normal`,
    }).catch(() => undefined);
  }
  spiking.set(ctx.activeOrgId, now);
  return { spiking: now.size };
}
