import { describe, expect, test } from 'bun:test';
import type { NodeSummary, ReleaseView } from '@swarmy/core';
import { deployWords, diagnosisWords, serversWords, sparkPath, trafficValue, whenWords } from './app-board-words';

const NOW = Date.parse('2026-09-26T10:42:00Z');
const ago = (min: number): string => new Date(NOW - min * 60_000).toISOString();

function rel(status: ReleaseView['status'], tag: string, min: number, actor: string | null = 'calum@gomacrae.com'): ReleaseView {
  return {
    id: `r-${tag}`,
    stackName: 'analytics',
    status,
    images: [{ name: 'app', image: `ghcr.io/northwind/app:${tag}` }],
    actor,
    strategy: null,
    healthGate: null,
    notes: null,
    createdAt: ago(min),
  };
}

const node = (name: string, region: string | null, publicIp: string | null = '203.0.113.9'): NodeSummary =>
  ({ id: name, name, region, publicIp }) as NodeSummary;

describe('trafficValue', () => {
  test('null and non-finite read "no data yet", never 0', () => {
    expect(trafficValue(null)).toBe('no data yet');
    expect(trafficValue(undefined)).toBe('no data yet');
    expect(trafficValue(Number.NaN)).toBe('no data yet');
  });
  test('a real zero is a zero', () => expect(trafficValue(0)).toBe('0 req/min'));
  test('under 60 a minute stays per minute', () => {
    expect(trafficValue(4.25)).toBe('4.3 req/min');
    expect(trafficValue(42.4)).toBe('42 req/min');
  });
  test('60 a minute and up reads per second', () => {
    expect(trafficValue(60)).toBe('1 req/s');
    expect(trafficValue(586)).toBe('9.8 req/s');
    expect(trafficValue(2280)).toBe('38 req/s');
  });
});

describe('sparkPath', () => {
  test('nothing known → empty path', () => {
    expect(sparkPath([], 100, 20)).toBe('');
    expect(sparkPath([null, null], 100, 20)).toBe('');
  });
  test('min sits at the bottom inset, max at the top inset', () => {
    expect(sparkPath([0, 10], 100, 20)).toBe('M0.0 18.0 L100.0 2.0');
  });
  test('a flat line sits in the middle', () => {
    expect(sparkPath([5, 5, 5], 100, 20)).toBe('M0.0 10.0 L50.0 10.0 L100.0 10.0');
  });
  test('a null is a gap: the line lifts and starts again', () => {
    expect(sparkPath([0, null, 10], 100, 20)).toBe('M0.0 18.0 M100.0 2.0');
  });
});

describe('serversWords', () => {
  test('on no server → null', () => expect(serversWords([], true)).toBeNull());
  test('one server names it', () => {
    expect(serversWords([node('london-2', 'eu-west')], true)).toEqual({ primary: 'london-2', places: 'eu-west', privateOnly: false });
  });
  test('several count and list regions once', () => {
    const s = serversWords([node('a', 'eu-west'), node('b', 'eu-west'), node('c', 'us-east')], true);
    expect(s).toEqual({ primary: '3 servers', places: 'eu-west · us-east', privateOnly: false });
  });
  test('no address and no public IP → private network only', () => {
    expect(serversWords([node('home-lab', null, null)], false)?.privateOnly).toBe(true);
    expect(serversWords([node('home-lab', null, null)], true)?.privateOnly).toBe(false);
  });
});

describe('whenWords', () => {
  test('minutes, hours, yesterday, days', () => {
    expect(whenWords(ago(0), NOW)).toBe('just now');
    expect(whenWords(ago(14), NOW)).toBe('14 min ago');
    expect(whenWords(ago(180), NOW)).toBe('3 h ago');
    expect(whenWords(ago(30 * 60), NOW)).toBe('yesterday');
    expect(whenWords(ago(4 * 24 * 60), NOW)).toBe('4 days ago');
  });
});

describe('deployWords', () => {
  test('none → null', () => expect(deployWords([], NOW)).toBeNull());
  test('the live version, who and when', () => {
    expect(deployWords([rel('healthy', '42', 120)], NOW)).toEqual({ version: 'v42 · 2 h ago', who: 'Calum', inFlight: null });
  });
  test('a rollout in flight shows the live one plus the one deploying', () => {
    const d = deployWords([rel('deploying', '119', 1), rel('healthy', '118', 120, 'system')], NOW);
    expect(d).toEqual({ version: 'v118 · 2 h ago', who: 'swarmy', inFlight: 'v119 deploying' });
  });
});

describe('diagnosisWords', () => {
  test('skips the reason the row already says, adds what changed last', () => {
    const w = diagnosisWords({
      say: 'checkout is running 1 of 2 copies.',
      reasons: ['checkout is running 1 of 2 copies', 'checkout: error rate 6.2% (target <5.0%)'],
      head: rel('healthy', '42', 5),
    });
    expect(w.startsWith('Checkout: error rate 6.2% (target <5.0%). The last change was v42 at ')).toBe(true);
  });
  test('falls back to the incident, then to the sentence itself', () => {
    expect(diagnosisWords({ say: 'It is down.', reasons: [], incident: 'blog keeps crashing' })).toBe('Blog keeps crashing.');
    expect(diagnosisWords({ say: 'It is down.', reasons: [] })).toBe('It is down.');
  });
});
