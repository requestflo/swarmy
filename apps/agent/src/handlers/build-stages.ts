/**
 * Clone → build → push, as the builder container runs them (pure).
 *
 * The build program marks the first two with `SWARMY_META stage clone|build`
 * lines (captured, never logged — see `renderBuildProgram`). Push has no
 * marker: BuildKit pushes inside the same `buildctl build`, so it's read off
 * the plain progress — the first `#N pushing layers` / `#N pushing manifest`
 * line. Each stage is reported once, in order; a later stage never reopens an
 * earlier one. The controller times them as the frames arrive.
 */
import type { BuilderStage } from '@swarmy/core/protocol';

/** The marker line the program echoes when it starts a stage. */
export function stageMarker(stage: 'clone' | 'build'): string {
  return `echo "SWARMY_META stage ${stage}"`;
}

const ORDER: readonly BuilderStage[] = ['clone', 'build', 'push'];
const PUSHING = /^#\d+ pushing (?:layers|manifest)\b/m;

export interface BuildStageTracker {
  /** A captured `SWARMY_META` line (without the prefix), e.g. `stage clone`. */
  meta(line: string): void;
  /** Forwarded log text (whole lines). */
  text(chunk: string): void;
  readonly current: BuilderStage | null;
}

export function buildStageTracker(onEnter: (stage: BuilderStage) => void): BuildStageTracker {
  let current: BuilderStage | null = null;
  const enter = (stage: BuilderStage) => {
    if (current && ORDER.indexOf(stage) <= ORDER.indexOf(current)) return;
    current = stage;
    onEnter(stage);
  };
  return {
    meta(line) {
      const m = /^stage (clone|build)$/.exec(line.trim());
      if (m) enter(m[1] as BuilderStage);
    },
    text(chunk) {
      // Only once the build itself is under way (a clone never pushes).
      if (current === 'build' && PUSHING.test(chunk)) enter('push');
    },
    get current() {
      return current;
    },
  };
}
