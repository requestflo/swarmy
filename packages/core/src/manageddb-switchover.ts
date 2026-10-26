/**
 * A PLANNED managed-Postgres switchover — "Make this copy the writer" (board
 * 39), dragging the writer on the Data page (board 15), and the server-retire
 * flow: hand the writes to a chosen standby copy, or the most caught-up one,
 * without losing a committed write. PURE: who may take the writes, or why
 * not. The run's step decisions and the request label are
 * `manageddb-switchover-run.ts`; the runner is @swarmy/trpc
 * `manageddb-switchover.run.ts`; the promotion itself is the reconcile's own
 * pass, gated by `decideFailover` like any other.
 *
 * A copy may take the writes only when it is
 *  - the only task of its service: the promotion pass promotes a SERVICE, so a
 *    service holding two copies would put a writer and a standby behind one
 *    name (and the other copy would keep following the old writer);
 *  - streaming from the writer (`pg_stat_replication.state = streaming`);
 *  - within {@link SWITCHOVER_CATCH_UP_BYTES} of it. Writes are still going,
 *    so exactly 0 is not the bar here; the run pauses writes and then waits
 *    for 0 bytes behind the writer's final flushed position.
 * And the cluster must have a running writer, a gated topology, nothing else
 * in flight, and no app connected straight to the writer's address: the
 * promotion repoints the copies and the pooler, not an app's DATABASE_URL,
 * which keeps naming the old writer — a copy that can no longer save.
 */

/** One WAL segment: close enough to pause writes and wait for the rest. */
export const SWITCHOVER_CATCH_UP_BYTES = 16 * 1024 * 1024;

/** Why the writer is busy, in the words the controller and the dashboard both say. */
export const SWITCHOVER_BUSY = {
  held: 'A switch-over is held for your confirmation. Settle that first.',
  running: 'A switch-over is already running.',
  restarting: 'The main copy is restarting for an extension or memory change. Try again in a minute.',
} as const;

export type SwitchoverRefusal =
  | 'no-writer'
  | 'not-supported'
  | 'busy'
  | 'direct-apps'
  | 'no-standby'
  | 'unknown-target'
  | 'target-is-writer'
  | 'shared-copy'
  | 'not-streaming'
  | 'behind';

export interface SwitchoverMember {
  service: string;
  /** `swarmy.db.role`: primary · replica (others are ignored). */
  role: string;
  desired: number;
  running: number;
}

/** A `db.replication` row (`pg_stat_replication` on the writer, matched to its member). */
export interface SwitchoverStandby {
  service: string | null;
  nodeId: string | null;
  state: string | null;
  lagBytes: number | null;
}

export interface SwitchoverPlanInput {
  cluster: string;
  topology: string;
  members: readonly SwitchoverMember[];
  standbys: readonly SwitchoverStandby[];
  /** Why the writer is busy (a held failover, a switchover, a planned restart), or null. */
  busy?: string | null;
  /** Apps whose DATABASE_URL names the writer itself rather than the pooler. */
  directApps: readonly string[];
  /** The member service to hand the writes to; omitted = the most caught-up copy. */
  target?: string;
  /** Plain name of a member's copy ("wkr-2's copy"); defaults to the service. */
  copyName?: (service: string) => string;
}

export type SwitchoverPlan =
  | { ok: false; code: SwitchoverRefusal; reason: string; target?: string }
  | { ok: true; from: string; target: string; nodeId: string | null; behindBytes: number };

type Refused = Extract<SwitchoverPlan, { ok: false }>;
const MB = 1024 * 1024;
const amount = (b: number): string => (b >= MB ? `${Math.round(b / MB)} MB` : `${b} bytes`);
const refuse = (code: SwitchoverRefusal, reason: string, target?: string): Refused => ({
  ok: false,
  code,
  reason,
  ...(target ? { target } : {}),
});

/** One copy's verdict: eligible with its lag, or why not. */
function judge(m: SwitchoverMember, i: SwitchoverPlanInput, name: string): SwitchoverPlan {
  if (m.desired > 1 || m.running > 1) {
    const n = Math.max(m.desired, m.running);
    return refuse('shared-copy', `${m.service} runs ${n} standby copies as one service, so no one of them can take the writes on its own. Keep one standby copy per service first.`, m.service);
  }
  const row = i.standbys.find((s) => s.service === m.service);
  if (!row || row.state !== 'streaming') {
    const how = row?.state ? `is ${row.state}, not streaming` : 'isn’t streaming from the main copy';
    return refuse('not-streaming', `${name} ${how}, so it can't take the writes yet.`, m.service);
  }
  if (row.lagBytes === null) return refuse('behind', `How far behind ${name} is isn't measured yet, so it can't take the writes yet.`, m.service);
  if (row.lagBytes > SWITCHOVER_CATCH_UP_BYTES) {
    return refuse('behind', `${name} is ${amount(row.lagBytes)} behind. Wait until it catches up.`, m.service);
  }
  return { ok: true, from: '', target: m.service, nodeId: row.nodeId, behindBytes: row.lagBytes };
}

/** Who takes the writes in a planned switchover, or why nobody may. Deterministic. */
export function planSwitchover(i: SwitchoverPlanInput): SwitchoverPlan {
  const name = i.copyName ?? ((s: string) => s);
  if (i.topology === 'active-active') return refuse('not-supported', `Every copy of ${i.cluster} already takes writes.`);
  const writer = i.members.find((m) => m.role === 'primary');
  if (!writer || writer.running < 1) {
    return refuse('no-writer', `The main copy of ${i.cluster} isn't running, so this isn't a planned switch-over: swarmy's failover rule decides that one.`);
  }
  if (i.busy) return refuse('busy', i.busy);
  if (i.directApps.length > 0) {
    const apps = i.directApps.join(', ');
    return refuse('direct-apps', `${apps} ${i.directApps.length === 1 ? 'connects' : 'connect'} straight to the main copy, so after the switch ${i.directApps.length === 1 ? 'it' : 'they'} would reach a copy that can't save. Send ${i.directApps.length === 1 ? 'it' : 'them'} through the pooler first: the pooler follows the writer.`);
  }
  const standbys = i.members.filter((m) => m.role === 'replica' && m.desired > 0);
  if (i.topology === 'single' || standbys.length === 0) {
    return refuse('no-standby', `${i.cluster} has no standby copy to hand the writes to. Add one first.`);
  }
  if (i.target !== undefined) {
    if (i.target === writer.service) return refuse('target-is-writer', `${name(i.target)} already takes the writes.`, i.target);
    const m = standbys.find((s) => s.service === i.target);
    if (!m) return refuse('unknown-target', `${i.target} isn't a standby copy of ${i.cluster}.`, i.target);
    const v = judge(m, i, name(m.service));
    return v.ok ? { ...v, from: writer.service } : v;
  }
  const verdicts = standbys.map((m) => ({ m, v: judge(m, i, name(m.service)) }));
  const lag = (s: string) => i.standbys.find((r) => r.service === s)?.lagBytes ?? Number.POSITIVE_INFINITY;
  verdicts.sort((a, b) => lag(a.m.service) - lag(b.m.service) || a.m.service.localeCompare(b.m.service));
  const best = verdicts.find((x) => x.v.ok)?.v ?? verdicts[0]!.v;
  return best.ok ? { ...best, from: writer.service } : best;
}
