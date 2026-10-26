/**
 * The PITR window check before a point-in-time restore changes anything.
 *
 * A wal-g restore picks the newest base backup that finished at or before the
 * target; a target before every base backup used to be refused only by the
 * agent, AFTER the controller had taken the safety copy and stopped the
 * server. `pitrPreflight` asks the agent for the real window first
 * (`db.pitrWindow`, read-only: a `wal-g backup-list` in a sidecar) and refuses
 * a target outside it, in plain words, before anything is saved or stopped.
 *
 * The command reads off-box state (the WAL repo in S3), which no snapshot the
 * agent streams carries, so it is a command like `backup.list`. An agent that
 * predates it would drop the frame, so it is sent only to an agent that
 * advertised the `dbPitrWindow` capability. Otherwise the restore goes ahead
 * as before (the agent still refuses an unreachable target) and the skip is
 * logged.
 *
 * The last read per cluster is kept in process memory (re-read on demand,
 * never a DB row or a label) so the dashboard's window can prefer it over
 * the estimate worked out from the schedule.
 */
import { AGENT_CAPABILITY, DbPitrWindowResult, agentSupports } from '@swarmy/core/protocol';
import type { DbBackupEngine, ResticRepo } from '@swarmy/core/protocol';
import type { DbPitrWindowView } from '@swarmy/core';
import type { OrgContext } from '../context';
import { commandRejected } from '../errors';
import { errorTail } from './dbPitrRestore.service';
import { judgePitrTarget, type PitrTargetAsk } from './dbPitrWindow.judge';
import { knownWalCheck } from './dbWalCheck.cache';
import { judgeWalTarget, walGaps } from './dbWalCheck.judge';

/** Where and how to read the WAL repo: the restore's own node, destination and networks. */
export interface PitrWindowRequest {
  nodeId: string;
  repo: ResticRepo;
  network?: string;
  resticNetwork?: string;
}

export type PitrWindowRead = { status: 'read'; result: DbPitrWindowResult } | { status: 'unsupported'; reason: string };

/** Ask the agent for the window, only when it advertised the command. Throws when the read fails. */
export async function readPitrWindow(ctx: OrgContext, req: PitrWindowRequest): Promise<PitrWindowRead> {
  const build = ctx.hub.agentBuildFor?.(req.nodeId);
  if (!agentSupports(build?.capabilities, AGENT_CAPABILITY.dbPitrWindow)) {
    const which = build?.version ? `agent ${build.version}` : 'agent';
    return { status: 'unsupported', reason: `the ${which} on node ${req.nodeId} cannot read the window (it predates dbPitrWindow)` };
  }
  const raw = await ctx.hub.dispatch<unknown>(req.nodeId, 'db.pitrWindow', {
    engine: 'wal-g',
    repo: req.repo,
    network: req.network,
    resticNetwork: req.resticNetwork,
  });
  const parsed = DbPitrWindowResult.safeParse(raw);
  if (!parsed.success) throw new Error('the agent answered the window check with something unreadable');
  return { status: 'read', result: parsed.data };
}

// ── the last read per cluster (process memory) ───────────────────────────────

/** How long a read stays the dashboard's window before it falls back to the estimate. */
export const PITR_WINDOW_MAX_AGE_MS = 60 * 60_000;
const lastRead = new Map<string, { at: number; result: DbPitrWindowResult }>();
const key = (orgId: string, ref: string) => `${orgId}\u0000${ref}`;

export function rememberPitrWindow(orgId: string, ref: string, result: DbPitrWindowResult, now = Date.now()): void {
  lastRead.set(key(orgId, ref), { at: now, result });
}

/** The cluster's last read, while it is fresh; null otherwise. */
export function knownPitrWindow(orgId: string, ref: string, now = Date.now()): DbPitrWindowResult | null {
  const hit = lastRead.get(key(orgId, ref));
  if (!hit) return null;
  if (now - hit.at > PITR_WINDOW_MAX_AGE_MS) {
    lastRead.delete(key(orgId, ref));
    return null;
  }
  return hit.result;
}

/** PURE: the dashboard view of a read (or of why there is none). */
export function pitrWindowView(read: PitrWindowRead | null): DbPitrWindowView {
  if (!read || read.status === 'unsupported') {
    return { source: read ? 'unsupported' : 'none', window: null, backups: [], latestWalAt: null, checkedAt: null };
  }
  const r = read.result;
  return {
    source: 'agent',
    window: r.window,
    backups: r.backups.map((b) => ({ name: b.name, finishTime: b.finishTime })),
    latestWalAt: r.latestWalAt ?? null,
    checkedAt: r.checkedAt,
  };
}

// ── the preflight ────────────────────────────────────────────────────────────

export interface PitrPreflightInput extends PitrWindowRequest, PitrTargetAsk {
  engine: DbBackupEngine;
}

/**
 * Read the window and refuse a target outside it (or inside a WAL gap the
 * last check found), before the safety copy or the stop. Returns the read, or null when the check was skipped (logged):
 * an engine whose window cannot be read yet, or an agent without the command.
 * A failed read refuses too: the restore would fail at the same list, only
 * after the save and the stop.
 */
export async function pitrPreflight(
  ctx: OrgContext,
  input: PitrPreflightInput,
  warn: (msg: string) => void = console.warn,
): Promise<DbPitrWindowResult | null> {
  if (input.engine !== 'wal-g') {
    warn(`[dbBackup] PITR preflight skipped for ${input.ref}: only a wal-g window can be read, not ${input.engine}`);
    return null;
  }
  let read: PitrWindowRead;
  try {
    read = await readPitrWindow(ctx, input);
  } catch (e) {
    throw commandRejected(
      `swarmy couldn't read the recoverable window of ${input.ref} from its WAL repo, so nothing was restored, saved or stopped: ${errorTail(e, 300)}. Fix that and try again.`,
    );
  }
  if (read.status === 'unsupported') {
    warn(`[dbBackup] PITR preflight skipped for ${input.ref}: ${read.reason}; restoring without checking the window first`);
    return null;
  }
  rememberPitrWindow(ctx.activeOrgId, input.ref, read.result);
  const refusal = judgePitrTarget(read.result, input);
  if (refusal) throw commandRejected(refusal);
  // A gap the last WAL check found (this hour) is out of reach too; the
  // fresh backup list says where restores can reach past it again.
  const wal = knownWalCheck(ctx.activeOrgId, input.ref);
  const gap = wal ? judgeWalTarget(input.ref, walGaps(wal, read.result.backups), input.targetTime) : null;
  if (gap) throw commandRejected(gap);
  return read.result;
}
