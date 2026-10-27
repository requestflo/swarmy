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
 *  - streaming from the writer (`pg_stat_replication.state = streaming`);
 *  - within {@link SWITCHOVER_CATCH_UP_BYTES} of it. Writes are still going,
 *    so exactly 0 is not the bar here; the run pauses writes and then waits
 *    for 0 bytes behind the writer's final flushed position.
 * And the cluster must have a running writer, a gated topology and nothing
 * else in flight. A standby service holding several copies is no reason to
 * refuse: the plan names its most caught-up copy (`nodeId`), the request
 * carries it, and the promotion pass promotes that ONE copy, then brings the
 * service back as that copy alone (`reshape`: a few more seconds without
 * writes; manageddb-failover-copies). An app connected straight to the writer's address is no
 * reason to refuse: the promotion pass re-mints its DATABASE_URL for the new
 * writer and rolls it (`manageddb-app-repoint.ts`), so the plan names it in
 * `restarts` for the confirm to say.
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
  | 'no-standby'
  | 'unknown-target'
  | 'target-is-writer'
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
  /** Apps whose DATABASE_URL names the writer itself rather than the pooler: they restart onto the new one. */
  directApps: readonly string[];
  /** The member service to hand the writes to; omitted = the most caught-up copy. */
  target?: string;
  /** A server the writes must not move to (the retire flow's leaving server): its copies don't count. */
  avoidNodeId?: string;
  /** Plain name of a member's copy ("wkr-2's copy"); defaults to the service. */
  copyName?: (service: string) => string;
}

export type SwitchoverPlan =
  | { ok: false; code: SwitchoverRefusal; reason: string; target?: string }
  | {
      ok: true;
      from: string;
      target: string;
      nodeId: string | null;
      behindBytes: number;
      /** Apps wired straight to the writer: each gets a URL for the new writer and restarts onto it. */
      restarts: string[];
      /** The target service holds other copies too: it comes back as this one copy (writes stop again briefly). */
      reshape?: true;
    };

type Refused = Extract<SwitchoverPlan, { ok: false }>;
const MB = 1024 * 1024;
const amount = (b: number): string => (b >= MB ? `${Math.round(b / MB)} MB` : `${b} bytes`);
const refuse = (code: SwitchoverRefusal, reason: string, target?: string): Refused => ({
  ok: false,
  code,
  reason,
  ...(target ? { target } : {}),
});

/** A service's rows, the most caught-up streaming copy first. */
const bestRows = (i: SwitchoverPlanInput, service: string): SwitchoverStandby[] =>
  i.standbys
    .filter((s) => s.service === service && (!i.avoidNodeId || s.nodeId !== i.avoidNodeId))
    .sort((a, b) => Number(b.state === 'streaming') - Number(a.state === 'streaming') || (a.lagBytes ?? Infinity) - (b.lagBytes ?? Infinity) || (a.nodeId ?? '').localeCompare(b.nodeId ?? ''));

/** One member's verdict (its most caught-up copy): eligible with its lag, or why not. */
function judge(m: SwitchoverMember, i: SwitchoverPlanInput, name: string): SwitchoverPlan {
  const row = bestRows(i, m.service)[0];
  const shared = m.desired > 1 || m.running > 1 ? { reshape: true as const } : {};
  if (!row || row.state !== 'streaming') {
    const how = row?.state ? `is ${row.state}, not streaming` : 'isn’t streaming from the main copy';
    return refuse('not-streaming', `${name} ${how}, so it can't take the writes yet.`, m.service);
  }
  if (row.lagBytes === null) return refuse('behind', `How far behind ${name} is isn't measured yet, so it can't take the writes yet.`, m.service);
  if (row.lagBytes > SWITCHOVER_CATCH_UP_BYTES) {
    return refuse('behind', `${name} is ${amount(row.lagBytes)} behind. Wait until it catches up.`, m.service);
  }
  return { ok: true, from: '', target: m.service, nodeId: row.nodeId, behindBytes: row.lagBytes, restarts: [...i.directApps].sort(), ...shared };
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
  const lag = (s: string) => bestRows(i, s)[0]?.lagBytes ?? Number.POSITIVE_INFINITY;
  verdicts.sort((a, b) => lag(a.m.service) - lag(b.m.service) || a.m.service.localeCompare(b.m.service));
  const best = verdicts.find((x) => x.v.ok)?.v ?? verdicts[0]!.v;
  return best.ok ? { ...best, from: writer.service } : best;
}
