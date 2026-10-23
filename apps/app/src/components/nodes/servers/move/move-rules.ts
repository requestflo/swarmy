import { MOVE_STATE_LABEL, PINNED_DATA_LABELS, parseMoveState, type MoveStep } from '@swarmy/core';
import type { NodeStatusView } from '@swarmy/core';

/**
 * Can this service move, and to there? Pure. The same refusals the mover
 * makes before it touches anything (`volumeMove.service.ts`
 * `moveServiceData`), asked up front so the screen can say why instead of
 * starting a move that stops at once. Every reason is a plain sentence.
 */

export interface MoveSubject {
  /** Short name ("web"), for the sentences. */
  short: string;
  system: boolean;
  mode: 'replicated' | 'global';
  desired: number;
  labels: Record<string, string>;
  /** Named volumes from the live spec; undefined while still being read. */
  volumes: string[] | undefined;
}

export interface MoveTarget {
  id: string;
  name: string;
  status: NodeStatusView;
}

/** Why `s` can't move at all (null = it can, as far as swarmy can tell yet). */
export function subjectBlock(s: MoveSubject, admin: boolean): string | null {
  if (!admin) return 'Only admins and owners can move a service.';
  if (s.system) return `${s.short} is part of swarmy itself, so it stays where swarmy put it.`;
  if (s.labels[MOVE_STATE_LABEL]) return `${s.short} is already moving.`;
  if (s.mode === 'global') return `${s.short} runs on every server, so there is nowhere to move it.`;
  if (s.labels['swarmy.db.role'] === 'primary') return `${s.short} is a managed database. Move it with a switch-over from its database page.`;
  if (s.volumes && s.volumes.length === 0) return `${s.short} keeps no saved data on its server, so there is nothing to move. swarmy places its copies itself.`;
  const pinned = PINNED_DATA_LABELS.some((k) => s.labels[k]);
  if (s.desired > 1 && !pinned) return `${s.short} runs ${s.desired} copies, each with its own data, so there is no single copy to move.`;
  return null;
}

/** Why `to` can't take it (null = it can). */
export function targetBlock(fromId: string, to: MoveTarget): string | null {
  if (to.id === fromId) return 'It already runs here.';
  if (to.status === 'offline') return `${to.name} is offline.`;
  if (to.status === 'draining') return `${to.name} is being emptied.`;
  if (to.status !== 'online') return `${to.name} isn’t ready for work yet.`;
  return null;
}

/** Each step of a move in plain words (the `swarmy.move.state` label's `step`). */
export const STEP_WORDS: Record<MoveStep, string> = {
  serve: 'Opening a private copy channel',
  'copy-live': 'Copying its data while it keeps running',
  stop: 'Pausing it for the last changes',
  'copy-final': 'Copying the last changes',
  verify: 'Checking the copy matches, file by file',
  repin: 'Pointing it at the new server',
  start: 'Starting it on the new server',
  done: 'Done',
};

export const STEP_ORDER: MoveStep[] = ['serve', 'copy-live', 'stop', 'copy-final', 'verify', 'repin', 'start'];

/** The move step from a service's labels, or null when no move is running. */
export function moveStep(labels: Record<string, string> | undefined): MoveStep | null {
  return parseMoveState(labels?.[MOVE_STATE_LABEL])?.step ?? null;
}

export type MovePhase = 'starting' | 'moving' | 'done' | 'rolled-back' | 'not-started';

/** A move with no label after this long never started (the mover refused it up front). */
export const START_GRACE_MS = 30_000;

/**
 * Where a move stands, from what swarmy shows: the label while it runs,
 * then where the service is. The mover clears the label only after the
 * service runs on the new server, or after putting it back; `fresh` says the
 * placement was read after the label cleared (until then it is still moving).
 */
export function movePhase(o: { step: MoveStep | null; sawLabel: boolean; onTo: boolean; fresh: boolean; elapsedMs: number }): MovePhase {
  if (o.step) return 'moving';
  if (o.onTo) return 'done';
  if (o.sawLabel) return o.fresh ? 'rolled-back' : 'moving';
  return o.elapsedMs > START_GRACE_MS ? 'not-started' : 'starting';
}

/** The named volumes in a raw `docker service inspect` (Spec.TaskTemplate.ContainerSpec.Mounts). */
export function volumesFromInspect(inspect: unknown): string[] {
  const mounts = (inspect as { Spec?: { TaskTemplate?: { ContainerSpec?: { Mounts?: unknown } } } } | null)?.Spec?.TaskTemplate
    ?.ContainerSpec?.Mounts;
  if (!Array.isArray(mounts)) return [];
  const names = mounts
    .map((m) => m as { Type?: string; Source?: string })
    .filter((m) => (m.Type ?? 'volume') === 'volume' && typeof m.Source === 'string' && m.Source && !/^[0-9a-f]{64}$/.test(m.Source))
    .map((m) => m.Source!);
  return [...new Set(names)];
}
