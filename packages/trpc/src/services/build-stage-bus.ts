/**
 * In-memory bus for the builder's `buildStage` frames (clone → build → push).
 *
 * The gateway pushes each frame here keyed by the build's commandId, with the
 * node that sent it; the `runBuild` that dispatched that command listens for
 * its own id and ignores any other node (only the builder it chose may move
 * its stages). Pure infra — no DB; the listener does the org-scoped writes.
 */
import type { BuilderStage } from '@swarmy/core/protocol';

export interface BuildStageEvent {
  nodeId: string;
  stage: BuilderStage;
  /** Controller clock, so every stage of a build is timed on one clock. */
  at: Date;
}

type Listener = (e: BuildStageEvent) => void;

class BuildStageBus {
  private listeners = new Map<string, Set<Listener>>();

  /** Called by the gateway when a `buildStage` frame arrives. */
  emit(commandId: string, e: BuildStageEvent): void {
    for (const fn of [...(this.listeners.get(commandId) ?? [])]) fn(e);
  }

  /** Listen for one build's stages; returns the unsubscribe. */
  on(commandId: string, fn: Listener): () => void {
    let set = this.listeners.get(commandId);
    if (!set) this.listeners.set(commandId, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.listeners.delete(commandId);
    };
  }
}

/** Process-wide singleton shared by the gateway and the build service. */
export const buildStageBus = new BuildStageBus();
