import type { DeployEventDetail, DeployProgressPayload, DeployStage } from '@swarmy/core/protocol';
import type { DeployStep, StepKey, StepState } from './deploy-steps';

/**
 * Pure: fold a traced deploy's streamed events (`deploys.events`) into the
 * tracker. Each stage's state is its keys' latest status (a key = the
 * service or data step it's about): any failed → failed, all done → done,
 * else working. Times are the server's, measured from the deploy's start.
 * Merged over the polled state (./deploy-steps), which stays the fallback
 * for stages with no events or a stream gone quiet.
 */

export type DeployEvent = DeployProgressPayload & { seq: number };

export const STAGE_STEP: Record<DeployStage, StepKey> = { pull: 'image', data: 'data', start: 'start', route: 'https', health: 'health' };

export interface StageFold {
  state: StepState;
  /** Seconds from the deploy's start to its first event / to done. */
  startedSec: number;
  doneSec: number | null;
  /** The latest pull numbers (layers, bytes, digest) and image. */
  detail: DeployEventDetail;
  node: string;
}

const sec = (at: number, t0: number): number => Math.max(0, Math.round((at - t0) / 1000));

export function foldStages(events: readonly DeployEvent[], t0: number): Partial<Record<StepKey, StageFold>> {
  const by = new Map<StepKey, DeployEvent[]>();
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    const k = STAGE_STEP[e.stage];
    by.set(k, [...(by.get(k) ?? []), e]);
  }
  const out: Partial<Record<StepKey, StageFold>> = {};
  for (const [k, list] of by) {
    const latest = new Map<string, DeployEvent>();
    for (const e of list) latest.set(e.service ?? '', e);
    const last = [...latest.values()];
    const state: StepState = last.some((e) => e.status === 'failed') ? 'failed' : last.every((e) => e.status === 'done') ? 'done' : 'working';
    const detail: DeployEventDetail = {};
    for (const e of list) Object.assign(detail, e.detail ?? {});
    out[k] = {
      state,
      startedSec: sec(list[0]!.at, t0),
      doneSec: state === 'done' ? sec(Math.max(...last.map((e) => e.at)), t0) : null,
      detail,
      node: list[list.length - 1]!.node,
    };
  }
  return out;
}

/** "sha256:4be1…c07a". */
export function shortDigest(d: string): string {
  const hex = d.replace(/^sha256:/, '');
  return hex.length > 12 ? `sha256:${hex.slice(0, 4)}…${hex.slice(-4)}` : d;
}

const mb = (b: number): string => `${Math.max(1, Math.round(b / 1_000_000))} MB`;

/** "7 layers · 142 MB" for the image step's Controls line. */
export function layersLine(d: DeployEventDetail): string | null {
  if (!d.layersTotal) return null;
  return [`${d.layersTotal} layer${d.layersTotal === 1 ? '' : 's'}`, d.bytesTotal ? mb(d.bytesTotal) : null].filter(Boolean).join(' · ');
}

/**
 * Events win for a stage they cover; the polled state stands in where they
 * don't, and — once the stream has gone quiet — wherever it is further along
 * (done) than the events say.
 */
export function mergeSteps(polled: DeployStep[], folds: Partial<Record<StepKey, StageFold>>, stale: boolean): DeployStep[] {
  return polled.map((s) => {
    const f = folds[s.key];
    if (!f) return s;
    if (stale && s.state === 'done' && f.state !== 'done') return s;
    const facts = s.key === 'image' ? [layersLine(f.detail), f.detail.digest ? `digest ${shortDigest(f.detail.digest)}` : null].filter((x): x is string => !!x) : [];
    return { ...s, state: f.state, ...(facts.length ? { facts } : {}) };
  });
}

/** The server the work runs on: the latest event from a real node (not the controller's own). */
export function eventServer(events: readonly DeployEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) if (events[i]!.node !== 'swarmy') return events[i]!.node;
  return null;
}
