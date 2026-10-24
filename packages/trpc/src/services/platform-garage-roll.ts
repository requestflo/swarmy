/**
 * Garage minor / patch update, rolling (plans/epic-platform-upgrades.md §2.4:
 * "Garage (rolling for minor/patch; the registered migration for a major)").
 * Pure — the runner is `platform-garage-roll.run.ts`.
 *
 * Inside one major, Garage members interoperate, so the store is moved one
 * member at a time and never stops: `docker service update --detach
 * --update-parallelism 1 --update-order stop-first --update-delay 90s
 * --update-failure-action rollback` on the global `swarmy-garage` service
 * (node-local volumes: two tasks may never share a member's data). Swarm
 * replaces one member's task, then waits 90 s before the next. Meanwhile the
 * controller watches Garage's own cluster health: once a member restarts,
 * the store must be healthy again (every member connected) within 60 s —
 * shorter than Swarm's pause, so no second member goes down while the first
 * hasn't rejoined. If not, the controller aborts with `docker service
 * rollback` (every member back on the previous build) and the step fails.
 * A task that won't stay up is Swarm's own rollback; the step fails too.
 */
import { garageMajorOf } from './garage-admin';
import { digestOf, type ManifestComponentLite } from './platform-upgrade.plan';

export const GARAGE_SERVICE = 'swarmy-garage';
/** Swarm's pause between members. */
export const MEMBER_DELAY = '90s';
/** How long the store may stay unhealthy after a member restart before the roll is aborted (< MEMBER_DELAY). */
export const HEALTH_GRACE_MS = 60_000;

/** A Garage image's major from its tag (`dxflrs/garage:v2.4.1@…` → 2); untagged falls back to the admin-dialect guess. Pure. */
export function garageMajor(image: string): number {
  const tag = (image.split('@')[0] ?? '').split('/').pop()?.split(':')[1] ?? '';
  const m = /^v?(\d+)\./.exec(tag);
  return m ? Number(m[1]) : garageMajorOf(image);
}

export type GarageRollPlan = { action: 'skip'; detail: string } | { action: 'roll'; from: string; ref: string; digest: string };

/** Does this release move object storage inside its major? Pure. */
export function planGarageRoll(live: { image: string } | undefined, target: ManifestComponentLite | undefined): GarageRollPlan {
  if (!live) return { action: 'skip', detail: 'object storage is off' };
  if (!target?.digest) return { action: 'skip', detail: 'this release names no Garage build' };
  if (digestOf(live.image) === target.digest) return { action: 'skip', detail: 'object storage already runs this release' };
  const from = garageMajor(live.image);
  const to = garageMajor(target.ref);
  if (to < from) return { action: 'skip', detail: `this release names an older Garage major (v${to}); object storage is never downgraded` };
  if (to > from) return { action: 'skip', detail: `a Garage major (v${from} → v${to}) is the engine migration, not a rolling update` };
  return { action: 'roll', from: live.image, ref: target.ref, digest: target.digest };
}

/** Resume state, kept in the engines step's `data.garage`. */
export interface GarageRollData {
  from: string;
  /** The exact ref Swarm was given (mirrored copy or upstream@digest). */
  to: string;
  /** The BOM ref recorded on the store once it lands (`dxflrs/garage:v2.5.0`). */
  ref: string;
  digest: string;
  dispatchedAt: string;
  /** Swarm was seen rolling this update (older update states before that are ignored). */
  seenRolling?: boolean;
  unhealthySince?: number;
}

export interface GarageRollObs {
  /** The live service's `UpdateStatus.State` (undefined = none reported). */
  updateState: string | undefined;
  /** Member tasks running on the target build. */
  onTarget: number;
  members: number;
  /** Garage's cluster health; null when the admin API didn't answer. */
  health: { status: string; connected: number } | null;
  now: number;
}

export type GarageRollStep =
  | { action: 'wait'; detail: string }
  | { action: 'done'; detail: string }
  /** The controller must abort the roll (`docker service rollback`). */
  | { action: 'rollback'; reason: string }
  /** Swarm already put the previous build back. */
  | { action: 'fail'; reason: string };

/** One poll of the roll: what to do now, and the state to keep. Pure. */
export function garageRollTick(d: GarageRollData, o: GarageRollObs, timeoutMs = 10 * 60_000 + o.members * 3 * 60_000): { step: GarageRollStep; data: GarageRollData } {
  const next: GarageRollData = { ...d, seenRolling: d.seenRolling || o.updateState === 'updating' || o.onTarget > 0 };
  const tag = d.ref.split(':').pop();
  if (next.seenRolling && o.updateState?.startsWith('rollback')) {
    return { step: { action: 'fail', reason: `a member did not stay up on Garage ${tag}; Swarm put every member back on the previous build` }, data: next };
  }
  const healthy = o.health?.status === 'healthy' && o.health.connected >= o.members;
  if (healthy) {
    next.unhealthySince = undefined;
    if (o.onTarget >= o.members && o.updateState !== 'updating') {
      return { step: { action: 'done', detail: `object storage on Garage ${tag}, one member at a time (${o.members} member(s))` }, data: next };
    }
  } else {
    next.unhealthySince ??= o.now;
    if (o.now - next.unhealthySince > HEALTH_GRACE_MS) {
      const state = o.health ? `${o.health.status}, ${o.health.connected}/${o.members} connected` : 'not answering';
      return { step: { action: 'rollback', reason: `object storage stayed unhealthy (${state}) for over a minute after a member restarted` }, data: next };
    }
  }
  if (o.now - Date.parse(d.dispatchedAt) > timeoutMs) {
    return { step: { action: 'rollback', reason: `the rolling update did not finish within ${Math.round(timeoutMs / 60_000)} minutes` }, data: next };
  }
  const wait = healthy ? '' : ', waiting for the store to be healthy again';
  return { step: { action: 'wait', detail: `object storage: ${o.onTarget} of ${o.members} member(s) on Garage ${tag}${wait}` }, data: next };
}
