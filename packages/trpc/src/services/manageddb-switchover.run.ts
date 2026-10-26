import { randomBytes } from 'node:crypto';
import {
  DB_SWITCHOVER_LABEL,
  SWITCHOVER_SQL,
  abortSwitchoverRun,
  encodeSwitchoverRequest,
  newSwitchoverRun,
  withSwitchoverStep,
  type DbSwitchoverRunView,
  type SwitchoverPhase,
  type SwitchoverPlan,
  type SwitchoverStepStatus,
} from '@swarmy/core';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { commandRejected } from '../errors';
import { writeAudit } from './audit.service';
import { resolveManagerNode } from './dispatch.service';
import { recordIncidentEvent } from './incidents-record';
import { copyNamer, planDbSwitchover } from './manageddb-switchover.service';
import { putSwitchoverRun } from './manageddb-switchover.runs';
import { awaitPromotion, drainTo, followers, live, repointed, restoreWriter, until, type RunScope, type SwitchoverIo } from './manageddb-switchover.steps';

/**
 * Run a planned switchover (`db.switchover`, the retire flow): pause →
 * catch-up → promote → repoint → rejoin, each a pure decision from @swarmy/core
 * `manageddb-switchover-run`. The PROMOTION is the manageddb reconcile's own
 * pass (`decideFailover`, narrowed to the target by the request label), which
 * also repoints the other copies, the pooler and every app wired straight to
 * the writer (a new URL secret, a rolling restart); this runner only pauses,
 * stops, watches and re-joins. Any abort before the promotion gives the
 * writes back to the old writer. Audited `db.switchover.start` /
 * `db.switchover` / `db.switchover.abort` on the cluster; the progress lives
 * in the in-memory relay (`manageddb-switchover.runs.ts`).
 */

export type { SwitchoverIo } from './manageddb-switchover.steps';

export interface SwitchoverOptions {
  /** Already planned (the router plans before it answers); otherwise planned here. */
  plan?: SwitchoverPlan;
  /** Re-join the old writer as a standby. Default: start it again where its data is. */
  rejoin?: (demoted: SwarmServiceInfo) => Promise<void>;
  onStart?: (view: DbSwitchoverRunView) => void;
  say?: (message: string) => void;
  pollMs?: number;
  timeouts?: { drainMs?: number; promoteMs?: number; startMs?: number; repointMs?: number; rejoinMs?: number };
}

export interface SwitchoverResult {
  from: string;
  to: string;
  finalLsn: string;
  pausedSeconds: number;
  rejoined: boolean;
}

export async function runDbSwitchover(
  ctx: OrgContext,
  input: { stack: string; cluster: string; target?: string },
  io: SwitchoverIo,
  o: SwitchoverOptions = {},
): Promise<SwitchoverResult> {
  const plan = o.plan ?? (await planDbSwitchover(ctx, input)).plan;
  if (!plan.ok) throw commandRejected(plan.reason);
  const { stack, cluster } = input;
  const { from, target } = plan;
  const t = o.timeouts ?? {};
  const s: RunScope = { ctx, io, stack, cluster, from, target, pollMs: o.pollMs ?? 2_000 };
  const mgr = await resolveManagerNode(ctx);
  const iso = () => new Date(io.now()).toISOString();
  let view = newSwitchoverRun({ runId: `sw_${randomBytes(6).toString('hex')}`, stack, cluster, from, target, targetNodeId: plan.nodeId, startedAt: iso() });
  const put = () => putSwitchoverRun(ctx.activeOrgId, view);
  const step = (phase: SwitchoverPhase, status: SwitchoverStepStatus, message: string | null = null) => {
    view = withSwitchoverStep(view, phase, status, message, iso());
    put();
    if (message) o.say?.(message);
  };
  const named = copyNamer(ctx, stack, cluster);
  const [F, T] = [named(from), named(target)];
  const ref = `${stack}/${cluster}`;
  const audit = (action: string, metadata: Record<string, unknown>) =>
    writeAudit(ctx, { action, targetType: 'dbCluster', targetId: ref, metadata }).catch(() => undefined);
  const labels = (add: Record<string, string>, removeKeys: string[] = []) =>
    ctx.hub.dispatch(mgr.id, 'service.updateLabels', { service: from, add, removeKeys });
  const thaw = async () => {
    await io.psql(from, SWITCHOVER_SQL.thaw).catch(() => '');
    await io.psql(from, SWITCHOVER_SQL.reload).catch(() => '');
    await labels({}, [DB_SWITCHOVER_LABEL]).catch(() => undefined);
  };

  put();
  o.onStart?.(view);
  await audit('db.switchover.start', { from, to: target });
  const pausedAt = io.now();
  const at = iso();
  try {
    step('pause', 'running', `Pausing writes on ${F}.`);
    await labels({ [DB_SWITCHOVER_LABEL]: encodeSwitchoverRequest({ at, target }) });
    let finalLsn: string;
    try {
      await io.psql(from, SWITCHOVER_SQL.freeze);
      await io.psql(from, SWITCHOVER_SQL.reload);
      await io.psql(from, SWITCHOVER_SQL.endOpenWrites);
      await io.psql(from, SWITCHOVER_SQL.checkpoint);
      finalLsn = (await io.psql(from, SWITCHOVER_SQL.flushLsn)).trim();
      if (!/^[0-9A-F]+\/[0-9A-F]+$/i.test(finalLsn)) throw commandRejected(`couldn't read the main copy's last position (got "${finalLsn.slice(0, 40)}")`);
      step('pause', 'done', `Writes paused; the main copy's last change is at ${finalLsn}.`);
      step('catch-up', 'running', `Waiting for ${T} to replay up to ${finalLsn}.`);
      await drainTo(s, finalLsn, t.drainMs);
    } catch (e) {
      await thaw();
      throw e;
    }
    step('catch-up', 'done', `${T} has every change.`);

    step('promote', 'running', `Stopping ${F}; swarmy makes ${T} the writer.`);
    try {
      await labels({ [DB_SWITCHOVER_LABEL]: encodeSwitchoverRequest({ at, target, finalLsn }) });
      await ctx.hub.dispatch(mgr.id, 'service.scale', { service: from, replicas: 0 });
    } catch (e) {
      await thaw();
      throw e;
    }
    const d = await awaitPromotion(s, t.promoteMs);
    if (d.kind === 'abort' && !(await restoreWriter(s, mgr.id, t.startMs ?? 180_000))) throw commandRejected(d.reason);
    const pausedSeconds = Math.max(0, Math.round((io.now() - pausedAt) / 1000));
    view = { ...view, pausedSeconds };
    step('promote', 'done', `${T} takes the writes. Writes were paused for ${pausedSeconds} s.`);

    const who = followers(plan.restarts);
    step('repoint', 'running', `Pointing ${who} at it.`);
    const moved = await until(s, t.repointMs ?? 60_000, () => repointed(s));
    step('repoint', moved ? 'done' : 'warn', moved ? `${who[0]!.toUpperCase()}${who.slice(1)} follow the new writer.` : 'The repoint is still settling; the reconcile finishes it.');

    step('rejoin', 'running', `${F} starts again as a standby (its old data is kept aside).`);
    const demoted = live(s, from);
    const rejoin = o.rejoin ?? (async (m: SwarmServiceInfo) => void (await ctx.hub.dispatch(mgr.id, 'service.scale', { service: m.name, replicas: 1 })));
    if (demoted) await rejoin(demoted);
    const rejoined = await until(s, t.rejoinMs ?? 10 * 60_000, () => (live(s, from)?.runningReplicas ?? 0) > 0);
    step('rejoin', rejoined ? 'done' : 'warn', rejoined ? `${F} follows ${T}.` : `${F} is still copying from ${T}; nothing is lost meanwhile.`);

    await audit('db.switchover', { from, to: target, finalLsn, pausedSeconds, rejoined });
    await recordIncidentEvent(ctx, {
      groupKey: `db:${ref}`,
      kind: 'db.switchover.done',
      message: `Planned switch-over: ${target} took the writes from ${from} (writes paused ${pausedSeconds} s, nothing lost)`,
      severity: 'warning',
      meta: { from, to: target, finalLsn },
    }).catch(() => undefined);
    return { from, to: target, finalLsn, pausedSeconds, rejoined };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    view = abortSwitchoverRun(view, reason, iso());
    put();
    await audit('db.switchover.abort', { from, to: target, reason });
    throw e;
  }
}
