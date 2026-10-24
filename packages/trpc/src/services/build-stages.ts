/**
 * A build's timed stages, as views and as "usually" medians (pure).
 *
 * Rows are `BuildStage` history (clone · build · push from the builder,
 * scan · sign · rollout from the controller). Nothing here invents a stage:
 * a stage nobody recorded is simply absent.
 */
import { BUILD_STAGE_ORDER, type BuildStageKey } from '@swarmy/core/protocol';
import type { ImageScanView } from '@swarmy/core/views';

export type StageOutcome = 'running' | 'ok' | 'warn' | 'failed';
/** How a stage ended. */
export type FinishedOutcome = Exclude<StageOutcome, 'running'>;

export interface ScanFacts {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

/** Where the build's digest landed, from the live swarm when the rollout settled. */
export interface RolloutFacts {
  stack: string;
  /** Short service names running the digest (`checkout`, not `storefront_checkout`). */
  services: string[];
  ready: number;
  desired: number;
  /** Docker reported the rolling update `completed`: the previous copies were replaced. */
  drained?: boolean;
}

export interface StageFacts {
  /** First line of what went wrong (display-safe). */
  error?: string;
  scan?: ScanFacts;
  rollout?: RolloutFacts;
}

export interface BuildStageView {
  key: BuildStageKey;
  startedAt: string;
  finishedAt: string | null;
  outcome: StageOutcome;
  facts: StageFacts;
}

export interface StageRow {
  stage: string;
  startedAt: Date | string;
  finishedAt: Date | string | null;
  outcome: string;
  factsJson?: unknown;
}

/** How many recent successful builds "usually" looks at. */
export const USUAL_SAMPLE = 20;

const OUTCOMES = new Set<StageOutcome>(['running', 'ok', 'warn', 'failed']);
const iso = (d: Date | string): string => (typeof d === 'string' ? d : d.toISOString());
const isKey = (s: string): s is BuildStageKey => (BUILD_STAGE_ORDER as readonly string[]).includes(s);

/** Rows → views, in clone → rollout order; unknown stages are dropped. */
export function toStageViews(rows: readonly StageRow[] | undefined): BuildStageView[] {
  return (rows ?? [])
    .filter((r): r is StageRow & { stage: BuildStageKey } => isKey(r.stage))
    .sort((a, b) => BUILD_STAGE_ORDER.indexOf(a.stage) - BUILD_STAGE_ORDER.indexOf(b.stage))
    .map((r) => ({
      key: r.stage,
      startedAt: iso(r.startedAt),
      finishedAt: r.finishedAt ? iso(r.finishedAt) : null,
      outcome: OUTCOMES.has(r.outcome as StageOutcome) ? (r.outcome as StageOutcome) : 'running',
      facts: r.factsJson && typeof r.factsJson === 'object' ? (r.factsJson as StageFacts) : {},
    }));
}

/** A finished stage's duration in ms (null while it runs). */
export function stageMs(s: Pick<StageRow, 'startedAt' | 'finishedAt'>): number | null {
  if (!s.finishedAt) return null;
  return Math.max(0, Date.parse(iso(s.finishedAt)) - Date.parse(iso(s.startedAt)));
}

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

/**
 * "Usually" per stage: the median duration over the newest {@link USUAL_SAMPLE}
 * SUCCESSFUL builds (of one repo — the caller scopes it), counting only stages
 * that finished well. A stage with no such sample has no "usually".
 */
export function usualStageMs(
  history: ReadonlyArray<{ status: string; startedAt: Date | string | null; stages: readonly StageRow[] }>,
  sample = USUAL_SAMPLE,
): Partial<Record<BuildStageKey, number>> {
  const recent = history
    .filter((b) => b.status.toUpperCase() === 'SUCCEEDED' && b.startedAt)
    .sort((a, b) => Date.parse(iso(b.startedAt!)) - Date.parse(iso(a.startedAt!)))
    .slice(0, sample);
  const out: Partial<Record<BuildStageKey, number>> = {};
  for (const key of BUILD_STAGE_ORDER) {
    const ms = recent.flatMap((b) =>
      b.stages
        .filter((s) => s.stage === key && (s.outcome === 'ok' || s.outcome === 'warn'))
        .map(stageMs)
        .filter((x): x is number => x !== null),
    );
    const m = median(ms);
    if (m !== null) out[key] = m;
  }
  return out;
}

/** How a finished scan reads as a stage: clean is ok, critical/high is a warning, an error failed. */
export function scanStage(scan: Pick<ImageScanView, 'status' | 'criticalCount' | 'highCount' | 'mediumCount' | 'lowCount'>): {
  outcome: FinishedOutcome;
  facts: StageFacts;
} {
  if (scan.status === 'error') return { outcome: 'failed', facts: { error: 'the vulnerability scan couldn’t finish' } };
  const facts = {
    scan: { critical: scan.criticalCount, high: scan.highCount, medium: scan.mediumCount, low: scan.lowCount },
  };
  return { outcome: scan.criticalCount > 0 || scan.highCount > 0 ? 'warn' : 'ok', facts };
}

/** The first line of an error, short enough for a stage row. */
export function failureLine(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e ?? 'failed');
  return (text.split('\n')[0] ?? '').slice(0, 200) || 'failed';
}
