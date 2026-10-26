import {
  DB_FAILOVER_PENDING_LABEL,
  DB_POOLER_TARGET_LABEL,
  DB_SWITCHOVER_LABEL,
  POOLER_ROLE,
  STACK_LABEL,
  SWITCHOVER_SQL,
  drainDecision,
  promoteDecision,
  type PromoteDecision,
} from '@swarmy/core';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { commandRejected } from '../errors';
import { switchoverMembers } from './manageddb-switchover.service';

/**
 * The switchover runner's waits (manageddb-switchover.run.ts), each one a
 * loop around a pure decision from @swarmy/core `manageddb-switchover-run`.
 */

export interface SwitchoverIo {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** `psql -tAc <sql>` in the service's running task → its output; throws when it can't run. */
  psql(service: string, sql: string): Promise<string>;
}

export interface RunScope {
  ctx: OrgContext;
  io: SwitchoverIo;
  stack: string;
  cluster: string;
  from: string;
  target: string;
  pollMs: number;
}

export const live = (s: RunScope, name: string): SwarmServiceInfo | undefined =>
  switchoverMembers(s.ctx, s.stack, s.cluster).find((m) => m.name === name);

/** Wait for the copy to replay the paused writer's final position; throws the abort reason. */
export async function drainTo(s: RunScope, finalLsn: string, timeoutMs?: number): Promise<void> {
  const t0 = s.io.now();
  for (;;) {
    const replay = await s.io.psql(s.target, SWITCHOVER_SQL.replayLsn).then((o) => o.trim() || null).catch(() => null);
    const d = drainDecision({ finalLsn, replayLsn: replay, elapsedMs: s.io.now() - t0, ...(timeoutMs ? { timeoutMs } : {}) });
    if (d.kind === 'ready') return;
    if (d.kind === 'abort') throw commandRejected(d.reason);
    await s.io.sleep(Math.min(s.pollMs, 500));
  }
}

/** Wait for the reconcile to promote the copy (or hold it, or run out of time). */
export async function awaitPromotion(s: RunScope, timeoutMs?: number): Promise<PromoteDecision> {
  const t0 = s.io.now();
  for (;;) {
    const members = switchoverMembers(s.ctx, s.stack, s.cluster);
    const d = promoteDecision({
      targetRole: members.find((m) => m.name === s.target)?.labels['swarmy.db.role'],
      held: members.some((m) => m.labels[DB_FAILOVER_PENDING_LABEL] !== undefined),
      elapsedMs: s.io.now() - t0,
      ...(timeoutMs ? { timeoutMs } : {}),
    });
    if (d.kind !== 'wait') return d;
    await s.io.sleep(s.pollMs);
  }
}

/** Wait for a condition, bounded; false when it never came. */
export async function until(s: RunScope, timeoutMs: number, cond: () => boolean): Promise<boolean> {
  const deadline = s.io.now() + timeoutMs;
  while (!cond()) {
    if (s.io.now() > deadline) return false;
    await s.io.sleep(s.pollMs);
  }
  return true;
}

/**
 * The promotion did not come: give the writes back to the old writer. The
 * label goes FIRST (no planned fast path any more), and a copy that did get
 * promoted meanwhile wins — the old writer is never started as a second one.
 * Returns true when the copy turned out promoted after all.
 */
export async function restoreWriter(s: RunScope, managerId: string, startMs: number): Promise<boolean> {
  const { ctx, io } = s;
  await ctx.hub.dispatch(managerId, 'service.updateLabels', { service: s.from, add: {}, removeKeys: [DB_SWITCHOVER_LABEL] }).catch(() => undefined);
  if (live(s, s.target)?.labels['swarmy.db.role'] === 'primary') return true;
  const recovering = await io.psql(s.target, SWITCHOVER_SQL.inRecovery).then((o) => o.trim()).catch(() => 't');
  if (recovering.startsWith('f')) return true;
  await ctx.hub.dispatch(managerId, 'service.scale', { service: s.from, replicas: 1 }).catch(() => undefined);
  await until(s, startMs, () => (live(s, s.from)?.runningReplicas ?? 0) > 0);
  await io.psql(s.from, SWITCHOVER_SQL.thaw).catch(() => '');
  await io.psql(s.from, SWITCHOVER_SQL.reload).catch(() => '');
  return false;
}

/** The promotion pass repointed the old writer (its spec lost the request label) and the pooler. */
export function repointed(s: RunScope): boolean {
  const old = live(s, s.from);
  const oldOk = !!old && old.labels['swarmy.db.role'] === 'replica' && old.labels[DB_SWITCHOVER_LABEL] === undefined;
  const pooler = s.ctx.hub
    .liveInventory(s.ctx.activeOrgId)
    .services.find((x) => x.labels[STACK_LABEL] === s.stack && x.labels['swarmy.db.cluster'] === s.cluster && x.labels['swarmy.db.role'] === POOLER_ROLE);
  return oldOk && (!pooler || pooler.labels[DB_POOLER_TARGET_LABEL] === s.target);
}
