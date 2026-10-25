import type { LogLineView } from './build-log-parse';

/** The stages the builder runs, and so the only ones with log lines (scan, sign, roll out are the controller's). */
export type LogStage = 'clone' | 'build' | 'push';
export const LOG_STAGES: readonly LogStage[] = ['clone', 'build', 'push'];

/** BuildKit plain progress (`#7 [deps 2/2] RUN …`) or buildkitd's own start-up words. */
const BUILDKIT = /^#\d+ |^buildkitd\b/;
/** The same line the agent's stage tracker reads as "push started" (apps/agent build-stages.ts). */
const PUSHING = /^#\d+ pushing (?:layers|manifest)\b/;

/**
 * Which stage each log line belongs to (pure). The clone's git output comes
 * first; the first BuildKit line starts the build; the first `pushing
 * layers|manifest` line starts the push, exactly where the agent reports it.
 * A stage never reopens once a later one has started.
 */
export function lineStages(lines: readonly Pick<LogLineView, 'text'>[]): LogStage[] {
  let stage: LogStage = 'clone';
  return lines.map((l) => {
    if (stage === 'clone' && BUILDKIT.test(l.text)) stage = 'build';
    if (stage === 'build' && PUSHING.test(l.text)) stage = 'push';
    return stage;
  });
}

/** Lines per stage, for the rail ("214 lines") and to know which stages can be shown. */
export function stageLineCounts(stages: readonly LogStage[]): Record<LogStage, number> {
  const out: Record<LogStage, number> = { clone: 0, build: 0, push: 0 };
  for (const s of stages) out[s] += 1;
  return out;
}

export function isLogStage(key: string): key is LogStage {
  return (LOG_STAGES as readonly string[]).includes(key);
}
