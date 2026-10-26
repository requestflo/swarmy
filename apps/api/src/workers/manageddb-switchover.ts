import {
  DB_SWITCHOVER_LABEL,
  SWITCHOVER_SQL,
  parseSwitchoverRequest,
  switchoverRequested,
  switchoverStale,
  type SwitchoverRequest,
} from '@swarmy/core';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';

/**
 * The manageddb reconcile's side of a PLANNED switchover (`db.switchover`,
 * the retire flow; @swarmy/core `manageddb-switchover-run.ts`). The runner
 * pauses writes and stops the writer; the promotion is still the reconcile's
 * own pass, so a switchover and a failover can't drift apart:
 *
 *   - a fresh request skips the grace window and narrows `decideFailover` to
 *     the requested copy (`plannedPromotion`, in `maybePromote`);
 *   - a planned promotion is recorded as a switch-over: it enriches an open
 *     incident but never opens one, and the event is `info`, not a page;
 *   - a request left on a HEALTHY writer past its age is a run that died
 *     while writes were paused: the writer takes writes again and the label
 *     goes (it also holds the extension and memory steps while it is there).
 */

/** The fresh planned request on this writer's labels, or null. */
export function plannedRequest(labels: Record<string, string> | undefined, now: number): SwitchoverRequest | null {
  return switchoverRequested(labels, now) ? parseSwitchoverRequest(labels?.[DB_SWITCHOVER_LABEL]) : null;
}

export interface PromotionRecord {
  /** Incident-timeline kind. */
  kind: 'db.failover' | 'db.switchover';
  /** Incident-event severity: `warning` never opens an incident. */
  severity: 'warning' | 'critical';
  /** `db-failover` event severity. */
  signal: 'info' | 'critical';
  /** Lead word of the event message. */
  lead: (confirmed: boolean) => string;
}

/** How the promotion pass records a promotion: a planned one pages nobody. */
export function promotionRecord(planned: boolean): PromotionRecord {
  return planned
    ? { kind: 'db.switchover', severity: 'warning', signal: 'info', lead: () => 'Planned switch-over' }
    : { kind: 'db.failover', severity: 'critical', signal: 'critical', lead: (confirmed) => (confirmed ? 'Confirmed failover' : 'Automatic failover') };
}

export interface ThawSeams {
  /** psql -tAc <sql> in the writer's running task; null when nothing ran. */
  sql(statement: string): Promise<{ exitCode: number } | null>;
  dropLabel(): Promise<unknown>;
  audit(metadata: Record<string, unknown>): Promise<unknown>;
}

/**
 * A healthy writer still carrying a request past its age: undo the pause
 * (`ALTER SYSTEM RESET default_transaction_read_only` + reload), then drop the
 * label. The label stays when the reset didn't run, so the next tick retries.
 */
export async function thawStaleSwitchover(writer: Pick<SwarmServiceInfo, 'name' | 'labels'>, now: number, seams: ThawSeams): Promise<boolean> {
  if (!switchoverStale(writer.labels, now)) return false;
  const reset = await seams.sql(SWITCHOVER_SQL.thaw);
  if (!reset || reset.exitCode !== 0) return false;
  await seams.sql(SWITCHOVER_SQL.reload);
  await seams.dropLabel();
  const req = parseSwitchoverRequest(writer.labels[DB_SWITCHOVER_LABEL]);
  await seams.audit({ writer: writer.name, pausedAt: req?.at ?? null, target: req?.target ?? null });
  return true;
}
