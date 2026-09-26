import { signalTargetKind, type AlertSignal } from '@swarmy/core';

/**
 * How each signal reads as a sentence, and which knobs the controller really
 * honours. Only five signals read their rule threshold (the alert-evaluator's
 * disk / crash / lag / queue / error-rate checks); the level signals honour
 * the for-duration gate; everything else fires on the event. cost-budget
 * reads its threshold as the warn-at % of the workspace budget (Q6). cert-expiry's
 * 14 days is fixed in domain-verify, so it is not offered as a knob here.
 *
 * A rule's target (owner decision Q10) follows the metric with `prep`:
 * "error rate OF storefront", "disk used ON london-2", "a release fails its
 * health check IN any app". Signals without a target kind have no clause.
 */
export interface SignalPhrase {
  /** "error rate" — the metric token (or the whole event clause). */
  metric: string;
  /** The word before the target token ("of" / "on" / "in"); null = no target clause. */
  prep: 'of' | 'on' | 'in' | null;
  /** Comparison word; null = no threshold (the signal fires on the event). */
  op: 'above' | 'at least' | null;
  /** Value suffix: "%", " jobs", " s". */
  unit: string;
  presets: number[];
  /** Honours `forSeconds` (the evaluator's for-duration gate). */
  held: boolean;
}

const threshold = (metric: string, prep: 'of' | 'on' | 'in', op: 'above' | 'at least', unit: string, presets: number[]): SignalPhrase => ({
  metric,
  prep,
  op,
  unit,
  presets,
  held: true,
});
const event = (metric: string, held = false, prep: 'on' | 'in' | null = null): SignalPhrase => ({ metric, prep, op: null, unit: '', presets: [], held });

export const SIGNAL_PHRASE: Record<AlertSignal, SignalPhrase> = {
  'error-rate': threshold('error rate', 'of', 'above', '%', [2, 3, 5, 8]),
  'disk-usage': threshold('disk used', 'on', 'above', '%', [75, 80, 85, 90]),
  'queue-depth': threshold('waiting jobs', 'in', 'above', ' jobs', [100, 500, 1000, 5000]),
  'db-degraded': threshold('standby copy lag', 'of', 'above', ' s', [10, 30, 60, 300]),
  'crash-loop': threshold('restarts in 10 min', 'of', 'at least', '', [2, 3, 5, 10]),
  'node-offline': event('checking in stops', true, 'on'),
  'service-down': event('a part runs short of copies', true, 'in'),
  'backup-failed': event('a backup fails or misses its time', true),
  'store-unreachable': event('the telemetry store stops answering', true),
  'cert-expiry': event('a certificate has under 14 days left or fails to renew'),
  'build-failed': event('a build fails'),
  'deploy-failed': event('a release fails its health check', false, 'in'),
  'deploy-rolled-back': event('swarmy puts back a release by itself', false, 'in'),
  'db-failover': event('a database switches to its standby copy', false, 'in'),
  'error-new-issue': event('an error swarmy hasn’t seen shows up', false, 'in'),
  'error-regression': event('a fixed error comes back', false, 'in'),
  'error-spike': event('one error spikes far above its usual rate', false, 'in'),
  // The workspace budget (owner decision Q6): the threshold is the warn-at %.
  'cost-budget': { metric: 'the month’s projected cost', prep: null, op: 'at least', unit: '% of budget', presets: [50, 80, 90, 100], held: false },
};

/** Every phrase's target clause agrees with the signal catalogue's target kind. */
export function phraseTargetsAgree(): boolean {
  return (Object.keys(SIGNAL_PHRASE) as AlertSignal[]).every((s) => (SIGNAL_PHRASE[s].prep === null) === (signalTargetKind(s) === null));
}

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
