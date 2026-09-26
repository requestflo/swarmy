import type { AlertEventView, AlertsOverview } from '@swarmy/core';
import { plural } from '@/components/rowpage/row-page';
import { resourceName } from './rule-sentence';

export interface AlertsSay {
  /** The clause that matters ("2 alerts firing."); null when all quiet. */
  alarm: { text: string; tone: 'warn' | 'bad' } | null;
  lead: string;
  rest: string;
}

/**
 * The page sentence: "2 alerts firing. App errors and Part short of copies,
 * both on checkout." / "All quiet. 17 rules watching."
 */
export function alertsSay(o: AlertsOverview, firing: AlertEventView[]): AlertsSay {
  if (o.firing === 0) return { alarm: null, lead: 'All quiet.', rest: `${plural(o.rulesEnabled, 'rule')} watching.` };
  const names = [...new Set(firing.map((e) => e.ruleName ?? e.signal))];
  const listed =
    names.length === 0 ? '' : names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
  const where = [...new Set(firing.map((e) => resourceName(e.resource)))];
  const on = where.length !== 1 ? '' : firing.length === 1 ? ` on ${where[0]}` : `, ${firing.length === 2 ? 'both' : 'all'} on ${where[0]}`;
  return {
    alarm: { text: `${plural(o.firing, 'alert')} firing.`, tone: o.firingCritical > 0 ? 'bad' : 'warn' },
    lead: '',
    rest: listed ? `${listed}${on}.` : '',
  };
}

/** "17 rules on of 17, going to 2 channels. 1 alert resolved in the last day." */
export function alertsLede(o: AlertsOverview): string {
  return `${plural(o.rulesEnabled, 'rule')} on of ${o.rules}, going to ${plural(o.channels, 'channel')}. ${plural(o.resolved24h, 'alert')} resolved in the last day.`;
}
