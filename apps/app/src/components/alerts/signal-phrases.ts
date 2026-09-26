import type { AlertSignal } from '@swarmy/core';

/**
 * How each signal reads as a sentence, and which knobs the controller really
 * honours. Only five signals read their rule threshold (the alert-evaluator's
 * disk / crash / lag / queue / error-rate checks); the level signals honour
 * the for-duration gate; everything else fires on the event. cert-expiry's
 * 14 days is fixed in domain-verify, so it is not offered as a knob here.
 */
export interface SignalPhrase {
  /** "error rate" — the metric token (or the whole event clause). */
  metric: string;
  /** "of any app" — rules have no target in the schema; they watch everything. */
  scope: string;
  /** Comparison word; null = no threshold (the signal fires on the event). */
  op: 'above' | 'at least' | null;
  /** Value suffix: "%", " jobs", " s". */
  unit: string;
  presets: number[];
  /** Honours `forSeconds` (the evaluator's for-duration gate). */
  held: boolean;
}

const threshold = (metric: string, scope: string, op: 'above' | 'at least', unit: string, presets: number[]): SignalPhrase => ({
  metric,
  scope,
  op,
  unit,
  presets,
  held: true,
});
const event = (metric: string, held = false): SignalPhrase => ({ metric, scope: '', op: null, unit: '', presets: [], held });

export const SIGNAL_PHRASE: Record<AlertSignal, SignalPhrase> = {
  'error-rate': threshold('error rate', 'of any app', 'above', '%', [2, 3, 5, 8]),
  'disk-usage': threshold('disk used', 'on any server', 'above', '%', [75, 80, 85, 90]),
  'queue-depth': threshold('waiting jobs', 'in any queue', 'above', ' jobs', [100, 500, 1000, 5000]),
  'db-degraded': threshold('standby copy lag', 'of any database', 'above', ' s', [10, 30, 60, 300]),
  'crash-loop': threshold('restarts in 10 min', 'of any app part', 'at least', '', [2, 3, 5, 10]),
  'node-offline': event('a server stops checking in', true),
  'service-down': event('a part of an app runs short of copies', true),
  'backup-failed': event('a backup fails or misses its time', true),
  'store-unreachable': event('the telemetry store stops answering', true),
  'cert-expiry': event('a certificate has under 14 days left or fails to renew'),
  'build-failed': event('a build fails'),
  'deploy-failed': event('a release fails its health check'),
  'deploy-rolled-back': event('swarmy puts back a release by itself'),
  'db-failover': event('a database switches to its standby copy'),
  'error-new-issue': event('an app raises an error swarmy hasn’t seen'),
  'error-regression': event('a fixed error comes back'),
  'error-spike': event('one error spikes far above its usual rate'),
};

export const DURATION_PRESETS = [60, 300, 900] as const;

export function phraseFor(signal: string): SignalPhrase {
  return SIGNAL_PHRASE[signal as AlertSignal] ?? event(signal);
}

/** "5%" · "1,000 jobs" · "30 s" · "3". */
export function formatValue(signal: string, value: number | null): string {
  if (value === null) return '—';
  return `${value.toLocaleString('en-GB')}${phraseFor(signal).unit}`;
}

/** "right away" · "30 s" · "5 min" · "2 h". */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) return 'right away';
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${Math.round((seconds / 3600) * 10) / 10} h`;
}
