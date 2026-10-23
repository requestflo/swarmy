import type { AlertEventView, IncidentEventView, TrafficNowView } from '@swarmy/core';
import type { Tone } from '@/components/calm';
import { plural } from '@/components/apps/app-words';
import type { AppItem } from '@/components/apps/use-apps';
import { formatValue, type ChartPoint } from '@/components/incidents/incident-chart-model';
import { durationWords, type Guess } from '@/components/incidents/incident-guess';
import type { IncidentMetric } from '@/components/incidents/incident-scope';
import { perMin, regionArea } from '@/components/estate-map/map-flows';
import type { ServerGlance } from './use-servers-glance';

/**
 * The phone glance's words, pure: the incident's metric before vs now, the
 * best guess as one line, the alerts behind an incident (and the rest), and
 * the short facts beside each app and server.
 */

/** A disk this full is worth naming (the Servers line, and the glance's server dots). */
export const HOT_DISK_PCT = 80;

/** "5.8% of requests fail instead of 0.3%." — now vs the median before it opened; null when it can't be said. */
export function metricLine(metric: IncidentMetric | null, points: ChartPoint[], openedAt: string): string | null {
  const now = points.at(-1);
  const opened = Date.parse(openedAt);
  if (!metric || !now || now.t < opened) return null;
  const before = points.filter((p) => p.t < opened).map((p) => p.v).sort((a, b) => a - b);
  const typical = before[Math.floor(before.length / 2)];
  if (typical === undefined || now.v <= typical) return null;
  return metric === 'latency'
    ? `The slowest requests take ${durationWords(now.v)} instead of ${durationWords(typical)}.`
    : `${formatValue('errors', now.v)} of requests fail instead of ${formatValue('errors', typical)}.`;
}

/** swarmy's best guess as the glance says it, then the put-back when one is offered. */
export function causeLines(guess: Guess, putBackLabel: string | null): string[] {
  const lines = [guess.cause === 'unknown' ? 'swarmy isn’t sure what started it yet.' : guess.headline];
  if (putBackLabel) lines.push(`Putting back ${putBackLabel} goes one copy at a time, and your data isn’t touched.`);
  return lines;
}

/**
 * The firing alerts behind an incident — its timeline names them by an
 * `alert:<resource>` group key or `meta.resource` — and every other one.
 */
export function incidentAlerts(
  events: Pick<IncidentEventView, 'meta'>[],
  firing: AlertEventView[],
): { linked: AlertEventView[]; others: AlertEventView[] } {
  const resources = new Set<string>();
  for (const { meta } of events) {
    if (typeof meta.groupKey === 'string' && meta.groupKey.startsWith('alert:')) resources.add(meta.groupKey.slice('alert:'.length));
    if (typeof meta.resource === 'string' && meta.resource) resources.add(meta.resource);
  }
  return {
    linked: firing.filter((a) => resources.has(a.resource)),
    others: firing.filter((a) => !resources.has(a.resource)),
  };
}

/** "Also firing: Server wkr-3 is offline and 1 more" — one per signal + resource (each rule records its own event). */
export function alsoFiring(others: AlertEventView[]): string | null {
  const seen = new Map<string, AlertEventView>();
  for (const a of others) if (!seen.has(`${a.signal}|${a.resource}`)) seen.set(`${a.signal}|${a.resource}`, a);
  const [first, ...rest] = [...seen.values()];
  if (!first) return null;
  return `Also firing: ${first.message.replace(/\.$/, '')}${rest.length ? ` and ${rest.length} more` : ''}`;
}

/** An app's facts beside its name: its status word when it isn't calm (or its parts), then visits a minute. */
export function appFacts(a: Pick<AppItem, 'name' | 'words' | 'stat' | 'hosts'>, traffic: TrafficNowView | undefined): { word: string | null; facts: string } {
  const reporting = traffic && traffic.totals.state !== 'no-data';
  const rate = reporting && a.hosts.length ? (traffic.apps.find((x) => x.app === a.name)?.requestsPerMin ?? 0) : null;
  const visits = rate === null ? null : `${perMin(rate)} visits/min`;
  if (a.words.tone === 'ok') return { word: null, facts: [plural(a.stat.serviceCount, 'part'), visits].filter(Boolean).join(' · ') };
  return { word: a.words.word.toLowerCase(), facts: visits ?? '' };
}

/** "EU 434/min · US 178/min": where the visits come from (regions in one area add up); null when no edge reports. */
export function visitsByArea(regions: TrafficNowView['regions']): string | null {
  const by = new Map<string, number>();
  for (const r of regions) {
    if (r.requestsPerMin === null) continue;
    const area = regionArea(r.region) ?? 'No region';
    by.set(area, (by.get(area) ?? 0) + r.requestsPerMin);
  }
  return by.size ? [...by].map(([area, n]) => `${area} ${perMin(n)}/min`).join(' · ') : null;
}

/** A server's dot: down, being emptied, not ready or a disk past the Servers line's mark, else calm. */
export function serverTone(s: ServerGlance): { tone: Tone; word: string } {
  const st = s.node.status;
  if (st === 'offline') return { tone: 'bad', word: 'offline' };
  if (st === 'draining') return { tone: 'info', word: 'being emptied' };
  if (st !== 'online') return { tone: 'warn', word: 'not ready yet' };
  if ((s.disk ?? 0) >= HOT_DISK_PCT) return { tone: 'warn', word: `disk ${s.disk}% full` };
  return { tone: 'ok', word: 'online' };
}

/** "Fri, Oct 23" in the reader's locale. */
export function glanceDate(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}
