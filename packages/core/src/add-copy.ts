/**
 * "⌥-drag to add a copy" (board 9) — the PURE rule. Dropping a service on a
 * server with ⌥ held asks for one more copy, started THERE. Swarm can't put
 * one task on a named server without pinning every copy to it, and swarmy
 * never pins a copy by hand, so the copy keeps the service's own placement
 * (its constraints and `spread=` preferences, as the Placement tab shows them)
 * and swarmy asks Swarm's own rule (`placement-match.ts`) where one more copy
 * would start. It goes ahead only when that is the server it was dropped on,
 * and says so plainly when it isn't.
 *
 * Only stateless replicated services: a copy of a service with a named volume
 * would start with an EMPTY volume (data on disk stays on its server), global
 * services already run everywhere, and managed data adds copies its own way.
 * The IO (live spec, counts, the scale) is `@swarmy/trpc` `add-copy.service.ts`.
 */
import { MOVE_STATE_LABEL } from './volume-move';
import { PINNED_DATA_LABELS } from './data-pin';
import { REGION_PARENT_LABEL } from './inventory';
import { constraintHolds, nextTaskGoesTo, type ScheduleCandidate } from './placement-match';

export interface CopyServer extends Omit<ScheduleCandidate, 'copies'> {
  name: string;
  /** Online and accepting work. */
  ready: boolean;
  /** Copies of the service there; null = the server isn't reporting. */
  copies: number | null;
}

export interface AddCopyInput {
  service: {
    short: string;
    mode: 'replicated' | 'global';
    desired: number;
    system: boolean;
    labels: Record<string, string>;
    /** Named volumes it mounts. */
    volumes: readonly string[];
    placement?: { constraints?: string[]; preferences?: string[]; maxReplicasPerNode?: number };
  };
  /** Controller node id it was dropped on. */
  to: string;
  servers: readonly CopyServer[];
}

export type AddCopyPlan = { ok: false; reason: string } | { ok: true; replicas: number; body: string; note: string | null };

const MANAGED_KEYS = ['swarmy.db.cluster', 'swarmy.cache.cluster', 'swarmy.search.cluster', 'swarmy.vector.cluster', 'swarmy.vector.name', ...PINNED_DATA_LABELS];
const REGION_DECL = /^swarmy\.region\..+\.replicas$/;
const copies = (n: number): string => `${n} ${n === 1 ? 'copy' : 'copies'}`;
const list = (names: string[]): string => (names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/** The refusal when Swarm would start the copy on `other` instead of `target`. */
export function copyElsewhere(short: string, other: string, target: string): string {
  return `Swarm starts a new copy where ${short} has the fewest copies, then on the least busy server, so it would start on ${other}, not on ${target}. Drop it on ${other} instead.`;
}

/** What adding the copy does, in a sentence. */
export function copyBody(short: string, now: number, target: string): string {
  return `${short} runs ${copies(now)} now. One more starts on ${target} and shares the load; nothing moves and nothing restarts.`;
}

/** Why `service` can't get another copy at all (null = it can). Shared with the screen's first check. */
export function copyBlock(s: AddCopyInput['service'], to: string): string | null {
  if (s.system) return `${s.short} is part of swarmy itself, so swarmy decides where its copies run.`;
  if (s.mode === 'global') return `${s.short} runs one copy on every server already, so there is nothing to add on ${to}.`;
  if (s.labels[MOVE_STATE_LABEL]) return `${s.short} is moving right now.`;
  if (MANAGED_KEYS.some((k) => s.labels[k])) return `${s.short} is a managed data service. Add copies from its page under Data, where swarmy keeps them in step.`;
  if (s.volumes.length > 0) {
    return `${s.short} keeps its data on its server (${s.volumes.join(', ')}). A copy on ${to} would start with an empty volume, not with that data. Drag it without ⌥ to move it instead.`;
  }
  if (s.labels[REGION_PARENT_LABEL] || Object.keys(s.labels).some((k) => REGION_DECL.test(k))) {
    return `${s.short} runs a set number of copies in each region. Change them under its Placement.`;
  }
  if (s.desired === 0) return `${s.short} has no copies running. Start it first.`;
  return null;
}

export function planAddCopy(i: AddCopyInput): AddCopyPlan {
  const s = i.service;
  const target = i.servers.find((x) => x.id === i.to);
  const T = target?.name ?? i.to;
  const no = (reason: string): AddCopyPlan => ({ ok: false, reason });
  const block = copyBlock(s, T);
  if (block) return no(block);
  if (!target || !target.ready) return no(`${T} isn't ready for work right now.`);
  const rules = s.placement?.constraints ?? [];
  for (const rule of rules) {
    const holds = constraintHolds(rule, target.node);
    if (holds === null) return no(`swarmy can't tell whether ${T} meets ${s.short}'s placement rule "${rule}", so it won't guess.`);
    if (!holds) return no(`${s.short}'s placement rules keep it off ${T} (${rule}). Change them under its Placement first.`);
  }
  const max = s.placement?.maxReplicasPerNode ?? 0;
  if (max > 0 && (target.copies ?? 0) >= max) return no(`${s.short} runs at most ${copies(max)} per server, and ${T} has that already.`);
  if (target.copies === null) return no(`${T} isn't reporting what runs on it, so swarmy can't tell where Swarm would start the copy.`);

  // Where Swarm would start one more: every server it may use, as Swarm ranks them.
  const eligible = i.servers.filter(
    (x): x is CopyServer & { copies: number } =>
      x.ready && x.copies !== null && (max === 0 || x.copies < max) && rules.every((r) => constraintHolds(r, x.node) === true),
  );
  const silent = i.servers.filter((x) => x.ready && x.copies === null && rules.every((r) => constraintHolds(r, x.node) !== false));
  const best = nextTaskGoesTo(eligible, s.placement?.preferences);
  if (!best.some((x) => x.id === i.to)) return no(copyElsewhere(s.short, best[0]!.name, T));
  const ties = [...best.filter((x) => x.id !== i.to), ...silent].map((x) => x.name);
  const note = ties.length ? `${list(ties)} ${ties.length === 1 ? 'is' : 'are'} just as free, so Swarm may start it there instead.` : null;
  return { ok: true, replicas: s.desired + 1, body: copyBody(s.short, s.desired, T), note };
}
