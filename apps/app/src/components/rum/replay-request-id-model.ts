/**
 * Pure: where a failed request's id leads. The app's Logs & traces tab
 * searches its lines for the id over a live window (15 m / 1 h / 24 h), so
 * the link picks the smallest window that still reaches the request, and
 * there is no link once the request is older than the widest one (the id
 * still shows, to copy).
 */
import { LOG_RANGE_PRESETS, type LogRangePreset } from '@/components/observability/logs-shared';

/** Slack so a request right at the edge of a window is still inside it by the time the page loads. */
const SLACK_MS = 60_000;

export function logsRangeFor(ageMs: number): LogRangePreset | null {
  if (!Number.isFinite(ageMs) || ageMs < 0) return null;
  return LOG_RANGE_PRESETS.find((p) => ageMs + SLACK_MS <= p.ms)?.value ?? null;
}

export interface RequestIdLink {
  q: string;
  range: LogRangePreset;
}

/** The logs search for this id, or null when telemetry is off for the app or the request is out of reach. */
export function requestIdLink(id: string, requestAtMs: number, nowMs: number, telemetryOn: boolean): RequestIdLink | null {
  if (!telemetryOn) return null;
  const range = logsRangeFor(nowMs - requestAtMs);
  return range ? { q: id, range } : null;
}
