import { LOG_SEVERITY_FLOORS, logSeverityFromNumber, type LogSeverityView } from '@swarmy/core';

/** Hard cap on rows kept in the DOM — "virtualized-ish" per the slice spec. */
export const LOGS_ROW_CAP = 500;
/** Rows fetched per page (head page + each "Load older"). */
export const LOGS_PAGE_SIZE = 200;
/** Live-tail poll cadence: the window re-anchors every 10s. */
export const LOGS_LIVE_POLL_MS = 10_000;

/** Time-range presets for the logs filter bar. */
export const LOG_RANGE_PRESETS = [
  { value: '15m', label: '15m', ms: 15 * 60_000 },
  { value: '1h', label: '1h', ms: 60 * 60_000 },
  { value: '24h', label: '24h', ms: 24 * 60 * 60_000 },
] as const;
export type LogRangePreset = (typeof LOG_RANGE_PRESETS)[number]['value'];

export function rangePresetMs(preset: LogRangePreset): number {
  return LOG_RANGE_PRESETS.find((p) => p.value === preset)?.ms ?? 60 * 60_000;
}

/** Severity chips — each sets the OTel severity-number floor (undefined = all). */
export const LOG_SEVERITY_CHIPS = [
  { label: 'All', min: undefined },
  { label: 'Debug+', min: LOG_SEVERITY_FLOORS.debug },
  { label: 'Info+', min: LOG_SEVERITY_FLOORS.info },
  { label: 'Warn+', min: LOG_SEVERITY_FLOORS.warn },
  { label: 'Error+', min: LOG_SEVERITY_FLOORS.error },
] as const;

/** Everything the filter bar controls (the query window is derived separately). */
export interface LogFilters {
  range: LogRangePreset;
  /** Exact service name, or undefined for all services. */
  serviceName?: string;
  /** OTel severity-number floor, or undefined for all severities. */
  severityMin?: number;
  /** Body substring (already debounced by the bar). */
  search: string;
}

export const DEFAULT_LOG_FILTERS: LogFilters = { range: '1h', search: '' };

/** Hot Signal text tone for a severity number. */
export function severityTextClass(severityNumber: number): string {
  const sev: LogSeverityView = logSeverityFromNumber(severityNumber);
  if (sev === 'fatal' || sev === 'error') return 'text-status-offline';
  if (sev === 'warn') return 'text-status-warning';
  if (sev === 'debug' || sev === 'trace') return 'text-muted-foreground';
  return 'text-status-progress';
}

/** Hot Signal dot tone for a severity number (row markers). */
export function severityDotClass(severityNumber: number): string {
  const sev: LogSeverityView = logSeverityFromNumber(severityNumber);
  if (sev === 'fatal' || sev === 'error') return 'bg-status-offline';
  if (sev === 'warn') return 'bg-status-warning';
  if (sev === 'debug' || sev === 'trace') return 'bg-status-idle';
  return 'bg-status-progress';
}

/** Uppercase display label for a row (prefers the emitted SeverityText). */
export function severityDisplay(severityText: string, severityNumber: number): string {
  return (severityText || logSeverityFromNumber(severityNumber)).toUpperCase();
}
