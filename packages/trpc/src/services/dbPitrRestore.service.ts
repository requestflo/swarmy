/**
 * Managed-Postgres point-in-time restore, end to end (QA-087).
 *
 * The earlier path dispatched the wal-g fetch at the target while it was
 * still running (wal-g refuses a live, non-empty PGDATA), and read the DB
 * password from a running member first (a race, and impossible once the
 * target is stopped). This module owns the whole sequence:
 *
 *   1. Credentials: none cross the wire. A physical restore needs no DB
 *      password (it works on files). After it, the target's roles are reset
 *      from the target's OWN Docker secret, which is mounted in the member
 *      and read in-member over the local socket (`rotateRolesScript`). The
 *      restored data carries the SOURCE cluster's role passwords, which would
 *      lock the target's wired apps out.
 *   2. Scale the target to 0 and wait until its task is gone. The agent also
 *      refuses while any running container mounts the volume.
 *   3. `db.restore` on the node that holds the data volume: PGDATA is moved
 *      aside (kept), then base backup, WAL and recovery settings (see
 *      apps/agent pitr-restore.ts). A failure there is rolled back agent-side.
 *   4. Scale back up, wait until recovery ends and the server promotes,
 *      remove the recovery settings, reset the roles, check it answers, and
 *      audit. If it never promotes, stop it, put the kept PGDATA back, start
 *      it again, and report.
 *
 * Every error keeps its TAIL (the tool's real reason), not its head.
 */
import { PG_PASSWORD_FROM_MEMBER, dbPasswordPath } from '@swarmy/core';
import type { DbBackupEngine, DbRestoreResult, ResticRepo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { commandRejected } from '../errors';
import { writeAudit } from './audit.service';
import { resolveManagerNode } from './dispatch.service';
import { resolveExecTarget } from './live-resolve';
import { rotateRolesScript } from './manageddb.service';

const HOUR_MS = 3_600_000;

export interface PitrRestorePlan {
  /** `<stack>/<cluster>` of the target (audit). */
  targetRef: string;
  /** The target's primary service (its data volume is restored). */
  service: string;
  /** Desired replicas to come back up with (at least 1). */
  desiredReplicas: number;
  /** The target's password secret (`swarmy.db.passwordSecret`), when it has one. */
  passwordSecret?: string;
  replicationUser: string;
  /** Agent node holding the data volume. */
  nodeId: string;
  dataVolume: string;
  engine: DbBackupEngine;
  snapshotId: string;
  targetTime?: string;
  repo: ResticRepo;
  tags: string[];
  network: string;
  resticNetwork?: string;
  /** Destination id (audit). */
  targetId: string;
}

export interface PitrRestoreTiming {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
  /** How long the target may take to stop. */
  stopWaitMs?: number;
  /** How long recovery may take to finish and promote. */
  promoteWaitMs?: number;
  /** The aside suffix (tests); defaults to a UTC stamp. */
  stamp?: string;
}

export interface PitrRestoreView {
  mode: 'pitr';
  engine: DbBackupEngine;
  bytesRestored: string;
  recoveredTo?: string;
  backupName?: string;
  /** Where the pre-restore data is kept (never deleted). */
  keptAt?: string;
}

/** The recovery settings the restore stages, removed once the server promoted. */
export const PITR_RECOVERY_SETTINGS = [
  'restore_command',
  'recovery_target_time',
  'recovery_target_action',
  'recovery_target_timeline',
] as const;

/**
 * PURE: after promotion, drop the recovery settings (a standby cloned from
 * this writer later would otherwise inherit `recovery_target_time` and stop
 * replaying at it) and the prefetched WAL. This goes over the local socket,
 * which the official image trusts.
 */
export function pitrCleanupScript(): string {
  return [
    'set -e',
    "psql -v ON_ERROR_STOP=1 -U postgres -d postgres -tA <<'SQL'",
    ...PITR_RECOVERY_SETTINGS.map((k) => `ALTER SYSTEM RESET ${k};`),
    'SELECT pg_reload_conf();',
    'SQL',
    'rm -rf "$(dirname "${PGDATA:?}")/pitr-wal"',
  ].join('\n');
}

/** PURE: the server answers on TCP with the target's own password (its secret). */
export const PITR_VERIFY_SCRIPT = `${PG_PASSWORD_FROM_MEMBER} psql -U postgres -h 127.0.0.1 -p 5432 -d postgres -tAc "SELECT 1"`;

/** PURE: is the restored server still in recovery? (`t`/`f`). The local socket works mid-recovery. */
export const IN_RECOVERY_SCRIPT = 'psql -U postgres -d postgres -tAc "SELECT pg_is_in_recovery()"';

/** A UTC stamp for the aside copy: `20260926T101500Z`. */
export function pitrStamp(now: number): string {
  return new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/** The last ~600 chars of an error (the reason, not the preamble). */
export function errorTail(e: unknown, max = 600): string {
  const m = (e instanceof Error ? e.message : String(e)).trim();
  return m.length > max ? `…${m.slice(m.length - max)}` : m;
}

async function execIn(ctx: OrgContext, service: string, script: string): Promise<{ exitCode: number; output: string; containerId: string } | null> {
  const target = resolveExecTarget(ctx, service, { newest: true });
  if (!target) return null;
  try {
    const res = await ctx.hub.dispatch<{ exitCode: number; output?: string }>(
      target.nodeId,
      'exec',
      { target: { containerId: target.containerId }, cmd: ['sh', '-c', script], tty: false, stream: false },
      { timeoutMs: 60_000 },
    );
    return { exitCode: res.exitCode, output: (res.output ?? '').trim(), containerId: target.containerId };
  } catch {
    return null;
  }
}

async function waitForNoTask(ctx: OrgContext, service: string, t: Required<Pick<PitrRestoreTiming, 'sleep' | 'now' | 'pollMs'>>, waitMs: number): Promise<boolean> {
  const deadline = t.now() + waitMs;
  for (;;) {
    if (!resolveExecTarget(ctx, service)) return true;
    if (t.now() >= deadline) return false;
    await t.sleep(t.pollMs);
  }
}

/**
 * Wait for recovery to end (`pg_is_in_recovery() = f`). Fails early when the
 * server keeps restarting (a FATAL recovery error loops the task) rather than
 * waiting out the whole window.
 */
async function waitPromoted(
  ctx: OrgContext,
  service: string,
  t: Required<Pick<PitrRestoreTiming, 'sleep' | 'now' | 'pollMs'>>,
  waitMs: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const deadline = t.now() + waitMs;
  const seen = new Set<string>();
  let last = 'the server never answered';
  for (;;) {
    const res = await execIn(ctx, service, IN_RECOVERY_SCRIPT);
    if (res) {
      seen.add(res.containerId);
      if (res.exitCode === 0 && res.output.startsWith('f')) return { ok: true };
      last = res.exitCode === 0 ? 'still replaying WAL' : res.output || `psql exited ${res.exitCode}`;
      if (seen.size >= 3) return { ok: false, reason: `the server keeps restarting during recovery (last: ${errorTail(last, 300)})` };
    }
    if (t.now() >= deadline) return { ok: false, reason: `recovery did not finish within ${Math.round(waitMs / 60_000)} min (${errorTail(last, 300)})` };
    await t.sleep(t.pollMs);
  }
}

export async function runPitrRestore(ctx: OrgContext, plan: PitrRestorePlan, timing: PitrRestoreTiming = {}): Promise<PitrRestoreView> {
  const t = {
    sleep: timing.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
    now: timing.now ?? Date.now,
    pollMs: timing.pollMs ?? 5_000,
  };
  const stamp = timing.stamp ?? pitrStamp(t.now());
  const replicas = Math.max(1, plan.desiredReplicas);
  const manager = await resolveManagerNode(ctx);
  const scale = (n: number) => ctx.hub.dispatch(manager.id, 'service.scale', { service: plan.service, replicas: n });
  const restoreCmd = (action: 'restore' | 'rollback') => ({
    engine: plan.engine,
    mode: 'pitr' as const,
    // Only the service name is used (to read the server's data layout). No password.
    conn: { host: plan.service, port: 5432, user: 'postgres', password: '', database: 'postgres' },
    repo: plan.repo,
    snapshotId: plan.snapshotId,
    targetTime: plan.targetTime,
    tags: plan.tags,
    network: plan.network,
    resticNetwork: plan.resticNetwork,
    dataVolume: plan.dataVolume,
    pitrStamp: stamp,
    pitrAction: action,
  });
  const audit = (status: 'succeeded' | 'failed', extra: Record<string, unknown>) =>
    writeAudit(ctx, {
      action: 'db.restore',
      actorType: ctx.user ? 'user' : 'system',
      targetType: 'dbCluster',
      targetId: plan.targetRef,
      metadata: { mode: 'pitr', engine: plan.engine, targetId: plan.targetId, targetTime: plan.targetTime ?? null, stamp, status, ...extra },
    });
  const fail = async (message: string, extra: Record<string, unknown> = {}): Promise<never> => {
    await audit('failed', { error: message, ...extra });
    throw commandRejected(message);
  };

  // (2) stop the target.
  await scale(0);
  if (!(await waitForNoTask(ctx, plan.service, t, timing.stopWaitMs ?? 120_000))) {
    await scale(replicas).catch(() => undefined);
    return fail(`${plan.service} did not stop, so nothing was restored`);
  }

  // (3) aside + fetch + WAL + recovery, on the node holding the volume.
  let result: DbRestoreResult;
  try {
    result = await ctx.hub.dispatch<DbRestoreResult>(plan.nodeId, 'db.restore', restoreCmd('restore'), { timeoutMs: 4 * HOUR_MS });
  } catch (e) {
    await scale(replicas).catch(() => undefined);
    return fail(`PITR restore failed and ${plan.service} was started again on its previous data: ${errorTail(e)}`);
  }

  // (4) start it, wait for recovery to end and the server to promote.
  await scale(replicas);
  const promoted = await waitPromoted(ctx, plan.service, t, timing.promoteWaitMs ?? 30 * 60_000);
  if (!promoted.ok) {
    let rolledBack = false;
    let rollbackError = '';
    await scale(0).catch(() => undefined);
    if (await waitForNoTask(ctx, plan.service, t, timing.stopWaitMs ?? 120_000)) {
      try {
        await ctx.hub.dispatch(plan.nodeId, 'db.restore', restoreCmd('rollback'), { timeoutMs: HOUR_MS });
        rolledBack = true;
      } catch (e) {
        rollbackError = errorTail(e, 300);
      }
    } else {
      rollbackError = `${plan.service} did not stop`;
    }
    await scale(replicas).catch(() => undefined);
    return fail(
      rolledBack
        ? `${plan.service} did not recover: ${promoted.reason}. Its previous data was put back and it was started again.`
        : `${plan.service} did not recover: ${promoted.reason}. Putting its previous data back failed (${rollbackError}); it is kept at ${result.asidePath ?? `<PGDATA>.pre-pitr-${stamp}`}.`,
      { rolledBack, backupName: result.backupName ?? null },
    );
  }

  // Tidy the recovery settings, then give the roles the TARGET's password.
  const notes: string[] = [];
  const cleanup = await execIn(ctx, plan.service, pitrCleanupScript());
  if (!cleanup || cleanup.exitCode !== 0) notes.push(`recovery settings not removed: ${errorTail(cleanup?.output ?? 'no running task', 200)}`);
  if (plan.passwordSecret) {
    const roles = await execIn(ctx, plan.service, rotateRolesScript(dbPasswordPath(plan.passwordSecret), plan.replicationUser));
    if (!roles || roles.exitCode !== 0) notes.push(`roles not reset to this cluster's password: ${errorTail(roles?.output ?? 'no running task', 200)}`);
  }
  // With a secret, prove the target's OWN credentials work over TCP; a legacy
  // env-password cluster is checked over the local socket.
  const verify = await execIn(ctx, plan.service, plan.passwordSecret ? PITR_VERIFY_SCRIPT : 'psql -U postgres -d postgres -tAc "SELECT 1"');
  if (!verify || verify.exitCode !== 0 || verify.output !== '1') {
    return fail(
      `${plan.service} recovered and promoted but does not answer with its own password: ${errorTail(verify?.output ?? 'no running task', 300)}. The previous data is kept at ${result.asidePath ?? `<PGDATA>.pre-pitr-${stamp}`}.`,
      { backupName: result.backupName ?? null, notes },
    );
  }

  await audit('succeeded', {
    backupName: result.backupName ?? null,
    recoveredTo: result.recoveredTo ?? null,
    keptAt: result.asidePath ?? null,
    ...(notes.length > 0 ? { notes } : {}),
  });
  return {
    mode: 'pitr',
    engine: plan.engine,
    bytesRestored: String(result.bytesRestored ?? 0),
    ...(result.recoveredTo ? { recoveredTo: result.recoveredTo } : {}),
    ...(result.backupName ? { backupName: result.backupName } : {}),
    ...(result.asidePath ? { keptAt: result.asidePath } : {}),
  };
}
