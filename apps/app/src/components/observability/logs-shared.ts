/** The stream keeps at most this many lines on screen (the query's own limit). */
export const LOGS_ROW_CAP = 500;
/** Live poll cadence; keeps ticking while paused so "N new lines" stays true. */
export const LOGS_LIVE_POLL_MS = 2_500;

/** Time-range presets (`observability.logs` takes any from/to window). */
export const LOG_RANGE_PRESETS = [
  { value: '15m', label: '15 m', words: '15 minutes', ms: 15 * 60_000 },
  { value: '1h', label: '1 h', words: 'hour', ms: 60 * 60_000 },
  { value: '24h', label: '24 h', words: '24 hours', ms: 24 * 60 * 60_000 },
] as const;
export type LogRangePreset = (typeof LOG_RANGE_PRESETS)[number]['value'];

export function rangePreset(value: LogRangePreset): (typeof LOG_RANGE_PRESETS)[number] {
  return LOG_RANGE_PRESETS.find((p) => p.value === value) ?? LOG_RANGE_PRESETS[0];
}

/** Level word colour: text-safe tones, never coral. */
export const LEVEL_TEXT = {
  error: 'text-tone-bad',
  warn: 'text-tone-warn',
  info: 'text-tone-info',
  debug: 'text-muted-foreground',
} as const;

export const LEVEL_DOT = {
  error: 'bg-status-offline',
  warn: 'bg-status-warning',
  info: 'bg-status-progress',
  debug: 'bg-status-idle',
} as const;
