import { describe, expect, test } from 'bun:test';
import type { ServiceMapEdgeView } from '@swarmy/core';
import { rateWords, replayCalls, replayColumns } from './replay-graph-model';

const edge = (from: string, to: string, callsPerMin = 10): ServiceMapEdgeView => ({ from, to, callsPerMin, errorRate: 0, p95Ms: 40 });

describe('replay graph', () => {
  test('keeps only calls between the replay’s parts, by their own or stack-prefixed name', () => {
    const calls = replayCalls('storefront', ['web', 'api', 'worker'], [
      edge('web', 'api', 74),
      edge('storefront_web', 'storefront_api', 6),
      edge('api', 'checkout'),
      edge('other_web', 'api'),
      edge('api', 'api'),
    ]);
    expect(calls).toEqual([{ from: 'web', to: 'api', callsPerMin: 80, errorRate: 0 }]);
  });

  test('columns by call depth, unlinked parts after the linked ones in the first', () => {
    const parts = ['worker', 'cdn', 'api', 'web'];
    const calls = replayCalls('s', parts, [edge('web', 'api'), edge('api', 'worker'), edge('web', 'worker')]);
    expect(replayColumns(parts, calls)).toEqual([['web', 'cdn'], ['api'], ['worker']]);
  });

  test('a loop stays within the number of parts', () => {
    const parts = ['a', 'b'];
    const cols = replayColumns(parts, replayCalls('s', parts, [edge('a', 'b'), edge('b', 'a')]));
    expect(cols.flat().sort()).toEqual(['a', 'b']);
    expect(cols.length).toBeLessThanOrEqual(2);
  });

  test('rates', () => {
    expect([rateWords(74.3), rateWords(0.42)]).toEqual(['74/min', '0.4/min']);
  });
});
