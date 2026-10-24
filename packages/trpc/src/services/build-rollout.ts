/**
 * Has the build's digest rolled out? (pure — the watcher polls the live swarm).
 *
 * Judged only from Docker truth: the stack's services whose image carries the
 * build's `sha256:` digest, their running vs desired copies, and Docker's own
 * rolling-update state. "Drained" is claimed only when Docker says the update
 * `completed` — a first deploy has no previous copy, so it never says so.
 */
import { STACK_LABEL } from '@swarmy/core';
import type { RolloutFacts } from './build-stages';

export interface LiveServiceLike {
  name: string;
  image: string;
  desiredReplicas?: number;
  runningReplicas: number;
  updateStatus?: string;
  labels: Record<string, string>;
}

export type RolloutState =
  | { state: 'waiting' }
  | { state: 'rolling'; facts: RolloutFacts }
  | { state: 'done'; facts: RolloutFacts }
  | { state: 'failed'; facts: RolloutFacts; error: string };

/** `host/name@sha256:…` → `sha256:…` (null when the image isn't digest-pinned). */
export function digestOf(image: string): string | null {
  const at = image.indexOf('@sha256:');
  return at >= 0 ? image.slice(at + 1) : null;
}

export function rolloutProgress(services: readonly LiveServiceLike[], digest: string, stack: string): RolloutState {
  const mine = services.filter(
    (s) => s.image.includes(digest) && (s.labels[STACK_LABEL] ?? '') === stack,
  );
  if (mine.length === 0) return { state: 'waiting' };
  const desired = mine.reduce((n, s) => n + (s.desiredReplicas ?? s.runningReplicas), 0);
  const ready = mine.reduce((n, s) => n + Math.min(s.runningReplicas, s.desiredReplicas ?? s.runningReplicas), 0);
  const drained = mine.every((s) => s.updateStatus === 'completed');
  const facts: RolloutFacts = {
    stack,
    services: mine.map((s) => (s.name.startsWith(`${stack}_`) ? s.name.slice(stack.length + 1) : s.name)).sort(),
    ready,
    desired,
    ...(drained ? { drained: true } : {}),
  };
  if (mine.some((s) => s.updateStatus === 'rollback_started' || s.updateStatus === 'rollback_completed'))
    return { state: 'failed', facts, error: 'Docker put the previous copy back' };
  // Swarm's default failure action pauses the update when a new copy won't start.
  if (mine.some((s) => s.updateStatus === 'paused'))
    return { state: 'failed', facts, error: 'the update paused: a new copy didn’t start' };
  if (mine.some((s) => s.updateStatus === 'updating') || ready < desired) return { state: 'rolling', facts };
  return { state: 'done', facts };
}
