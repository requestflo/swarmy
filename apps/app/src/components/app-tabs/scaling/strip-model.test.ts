import { describe, expect, test } from 'bun:test';
import type { NodeSummary } from '@swarmy/core';
import { copiesByServer, copiesHint, memWords, serverCards, serverNote, spreadWords } from './strip-model';

const GB = 1024 ** 3;
const node = (id: string, status: NodeSummary['status'] = 'online', memPct: number | null = 50): NodeSummary =>
  ({
    id,
    name: id,
    hostname: id,
    role: 'worker',
    status,
    engineVersion: null,
    os: null,
    arch: null,
    resources: { cpus: 4, memBytes: 8 * GB },
    agentVersion: null,
    agentCommit: null,
    agentUpdateAvailable: false,
    lastSeenAt: null,
    live: memPct === null ? null : { cpuPercent: 10, memPercent: memPct },
  }) as NodeSummary;

const svc = (id: string, name = id) => ({ id, name });

describe('copiesByServer', () => {
  test('one server holds them all', () => {
    expect([...copiesByServer(['a'], 4)]).toEqual([['a', 4]]);
  });
  test('as many servers as copies → one each', () => {
    expect([...copiesByServer(['a', 'b', 'c'], 3).values()]).toEqual([1, 1, 1]);
  });
  test('otherwise the split is unknown, never guessed', () => {
    expect([...copiesByServer(['a', 'b'], 5).values()]).toEqual([null, null]);
  });
});

describe('serverCards', () => {
  const nodes = [node('a'), node('b', 'online', 90), node('c', 'offline'), node('d', 'draining', null)];
  const servicesByNode = new Map([
    ['a', [svc('s1', 'shop_web'), svc('s2', 'shop_api')]],
    ['b', [svc('s2', 'shop_api')]],
    ['d', []],
  ]);
  const cards = serverCards({ nodes, servicesByNode, serviceId: 's1', running: 2, label: (n) => n.replace('shop_', '') });

  test('skips offline servers, puts the ones with a copy first', () => {
    expect(cards.map((c) => c.node.id)).toEqual(['a', 'b', 'd']);
  });
  test('one server with copies holds all of them; others listed by short name', () => {
    expect(cards[0]!.copies).toBe(2);
    expect(cards[0]!.others).toEqual(['api']);
    expect(cards[1]!.copies).toBe(0);
  });
  test('memory from the live snapshot, hot at 85%, emptying servers are idle', () => {
    expect(cards[0]!.memUsed).toBe(4 * GB);
    expect(cards[1]!.tone).toBe('warn');
    expect(cards[2]!.memUsed).toBeNull();
    expect(cards[2]!.tone).toBe('idle');
  });
  test('notes and the spread', () => {
    expect(serverNote(cards[0]!, 'web')).toBe('2 copies of web');
    expect(serverNote(cards[1]!, 'web')).toBe('no web here');
    expect(serverNote(cards[2]!, 'web')).toBe('emptying · takes no new copies');
    expect(serverNote({ ...cards[0]!, copies: null }, 'web')).toBe('web runs here');
    expect(spreadWords(cards, 2, 2, 'web')).toBe('2 copies, all on a');
    expect(copiesHint(cards, 2, 2, 'web')).toBe('Both copies are on a, so if it stops, web stops.');
    expect(copiesHint(cards, 3, 3, 'web')).toBe('All 3 copies are on a, so if it stops, web stops.');
  });
  test('a copy short: says what is up, not "all"', () => {
    expect(spreadWords(cards, 3, 2, 'web')).toBe('2 of 3 copies up, on a');
    expect(copiesHint(cards, 2, 1, 'web')).toBe("The one copy that's up is on a, so if it stops, web stops.");
  });
});

test('copiesHint for one copy and for a spread', () => {
  expect(copiesHint(undefined, 1, 1, 'api')).toContain('Two keep it up');
  const spread = serverCards({
    nodes: [node('a'), node('b')],
    servicesByNode: new Map([['a', [svc('x')]], ['b', [svc('x')]]]),
    serviceId: 'x',
    running: 2,
    label: (n) => n,
  });
  expect(copiesHint(spread, 2, 2, 'x')).toBe('Spread over 2 servers, so one can stop without an outage.');
  expect(spreadWords(spread, 2, 2, 'x')).toBe('2 copies on 2 servers');
});

test('memWords', () => {
  expect(memWords(4.6 * GB, 8 * GB)).toBe('4.6 / 8 GB');
  expect(memWords(null, 8 * GB)).toBe('? / 8 GB');
  expect(memWords(null, null)).toBe('—');
});
