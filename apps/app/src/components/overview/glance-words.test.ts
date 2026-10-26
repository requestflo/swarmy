import { describe, expect, test } from 'bun:test';
import type { AlertEventView, NodeSummary, TrafficNowView } from '@swarmy/core';
import type { Guess } from '@/components/incidents/incident-guess';
import { alsoFiring, appFacts, causeLines, incidentAlerts, metricLine, serverTone, visitsByArea } from './glance-words';
import type { ServerGlance } from './use-servers-glance';

const OPENED = Date.parse('2026-10-23T09:14:00Z');
const at = (min: number): number => OPENED + min * 60_000;

describe('metricLine', () => {
  const before = [{ t: at(-12), v: 220 }, { t: at(-9), v: 240 }, { t: at(-6), v: 260 }];
  test('says now against the median before it opened', () => {
    expect(metricLine('latency', [...before, { t: at(3), v: 1800 }], new Date(OPENED).toISOString())).toBe(
      'The slowest requests take 1.8 s instead of 240 ms.',
    );
    const errs = [{ t: at(-6), v: 0.3 }, { t: at(-3), v: 0.4 }, { t: at(3), v: 5.8 }];
    expect(metricLine('errors', errs, new Date(OPENED).toISOString())).toBe('5.8% of requests fail instead of 0.4%.');
  });
  test('says nothing without a before, a now after it opened, or when it is no worse', () => {
    const iso = new Date(OPENED).toISOString();
    expect(metricLine('latency', [{ t: at(3), v: 1800 }], iso)).toBeNull();
    expect(metricLine('latency', before, iso)).toBeNull();
    expect(metricLine('latency', [...before, { t: at(3), v: 200 }], iso)).toBeNull();
    expect(metricLine(null, [...before, { t: at(3), v: 1800 }], iso)).toBeNull();
  });
});

describe('causeLines', () => {
  const guess = (cause: Guess['cause'], headline: string): Guess => ({ cause, headline, lines: [], suspect: null, putBack: null, traceId: null });
  test('reuses the best guess, then offers the put-back', () => {
    expect(causeLines(guess('deploy', 'Likely the deploy: v42 went out 2 minutes before this started.'), 'v41')).toEqual([
      'Likely the deploy: v42 went out 2 minutes before this started.',
      'Putting back v41 goes one copy at a time, and your data isn’t touched.',
    ]);
  });
  test('says how long the last put-back took, only beside a put-back', () => {
    const g = guess('deploy', 'Likely the deploy.');
    expect(causeLines(g, 'v41', 41).at(-1)).toBe('The last put-back took 41 s.');
    expect(causeLines(g, null, 41)).toEqual(['Likely the deploy.']);
  });
  test('an unknown cause says so plainly', () => {
    expect(causeLines(guess('unknown', 'Not sure yet.'), null)).toEqual(['swarmy isn’t sure what started it yet.']);
  });
});

function alert(id: string, signal: string, resource: string, message: string): AlertEventView {
  return { id, ruleId: `rule-${id}`, ruleName: null, signal, severity: 'warning', resource, message, status: 'firing', notify: 'sent', firedAt: new Date(OPENED).toISOString(), resolvedAt: null };
}

describe('incidentAlerts / alsoFiring', () => {
  const firing = [
    alert('a1', 'latency', 'service:analytics_web', 'analytics_web is slow'),
    alert('a2', 'latency', 'service:analytics_web', 'analytics_web is slow'),
    alert('a3', 'disk-usage', 'node:london-2', 'The disk on server london-2 is 81% full.'),
    alert('a4', 'disk-usage', 'node:london-2', 'The disk on server london-2 is 81% full.'),
    alert('a5', 'node-offline', 'node:wkr-3', 'Server wkr-3 is offline'),
  ];
  test('links alerts by the alert group key or a named resource', () => {
    const byGroup = incidentAlerts([{ meta: { groupKey: 'alert:service:analytics_web', signal: 'latency' } }], firing);
    expect(byGroup.linked.map((a) => a.id)).toEqual(['a1', 'a2']);
    const byResource = incidentAlerts([{ meta: { groupKey: 'release:analytics', resource: 'node:wkr-3' } }], firing);
    expect(byResource.linked.map((a) => a.id)).toEqual(['a5']);
  });
  test('names the first other alert once, and counts the rest', () => {
    const { others } = incidentAlerts([{ meta: { groupKey: 'alert:service:analytics_web' } }], firing);
    expect(alsoFiring(others)).toBe('Also firing: The disk on server london-2 is 81% full and 1 more');
    expect(alsoFiring(others.slice(0, 2))).toBe('Also firing: The disk on server london-2 is 81% full');
    expect(alsoFiring([])).toBeNull();
  });
});

const traffic = (apps: TrafficNowView['apps'], state: 'reporting' | 'no-data' = 'reporting'): TrafficNowView =>
  ({ totals: { state }, apps }) as unknown as TrafficNowView;

describe('appFacts', () => {
  const app = (tone: 'ok' | 'warn', hosts: string[]) => ({
    name: 'storefront',
    words: { tone, word: tone === 'ok' ? 'Online' : 'Needs you', say: '', tech: '', attention: tone !== 'ok' },
    stat: { serviceCount: 4 } as never,
    hosts,
  });
  const now = traffic([{ app: 'storefront', requestsPerMin: 444.3, errors5xxPerMin: 0, errorShare: 0, hosts: [] }]);
  test('calm apps show parts and visits; others lead with their word', () => {
    expect(appFacts(app('ok', ['shop.example']), now)).toEqual({ word: null, facts: '4 parts · 444 visits/min' });
    expect(appFacts(app('warn', ['shop.example']), now)).toEqual({ word: 'needs you', facts: '444 visits/min' });
  });
  test('no address or no edge reporting means no visits figure, never a zero', () => {
    expect(appFacts(app('ok', []), now).facts).toBe('4 parts');
    expect(appFacts(app('ok', ['shop.example']), traffic([], 'no-data')).facts).toBe('4 parts');
    expect(appFacts(app('ok', ['shop.example']), undefined).facts).toBe('4 parts');
  });
});

describe('serverTone', () => {
  const s = (status: NodeSummary['status'], disk: number | null): ServerGlance => ({ node: { status } as NodeSummary, cpu: null, mem: null, disk });
  test('offline, emptying, not ready, a full disk, calm', () => {
    expect(serverTone(s('offline', null))).toEqual({ tone: 'bad', word: 'offline' });
    expect(serverTone(s('draining', 20))).toEqual({ tone: 'info', word: 'being emptied' });
    expect(serverTone(s('pending', null))).toEqual({ tone: 'warn', word: 'not ready yet' });
    expect(serverTone(s('online', 81))).toEqual({ tone: 'warn', word: 'disk 81% full' });
    expect(serverTone(s('online', 42))).toEqual({ tone: 'ok', word: 'online' });
  });
});

describe('visitsByArea', () => {
  const region = (r: string | null, n: number | null) => ({ region: r, requestsPerMin: n }) as TrafficNowView['regions'][number];
  test('areas add up; a silent region is left out', () => {
    expect(visitsByArea([region('eu-west', 400), region('eu-central', 34.4), region('us-east', 178), region('us-west', null)])).toBe('EU 434/min · US 178/min');
    expect(visitsByArea([region('us-west', null)])).toBeNull();
  });
});
