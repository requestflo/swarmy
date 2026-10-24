import { describe, expect, test } from 'bun:test';
import type { KvSizeWarning } from '@swarmy/core';
import { swarmKvSizeProblems } from './resilience.swarm-kv';

const doc = (ratio: number, severity: 'warn' | 'crit'): KvSizeWarning => ({
  scope: 'document', collection: 'stack', id: 'shop', bytes: Math.round(65_536 * ratio), limit: 65_536, ratio, severity,
});

describe('resilience check swarm-kv-size', () => {
  test('no signal or no warnings raises nothing', () => {
    expect(swarmKvSizeProblems(undefined)).toEqual([]);
    expect(swarmKvSizeProblems({ warnings: [] })).toEqual([]);
  });

  test('a nearly full document is a warn naming it, with a fix link to the config list', () => {
    const [p] = swarmKvSizeProblems({ warnings: [doc(0.8, 'warn')] });
    expect(p).toMatchObject({
      id: 'swarm-kv-size/stack/shop',
      check: 'swarm-kv-size',
      severity: 'warn',
      title: 'A cluster config document is nearly full',
      resource: 'stack/shop',
      fixPath: '/settings/platform',
    });
    expect(p!.detail).toBe('stack/shop is 51.2 KB of its 64.0 KB limit (80%). At the limit swarmy refuses to save it, so changes to it stop.');
  });

  test('a full document is crit; the whole footprint is its own problem', () => {
    const total: KvSizeWarning = { scope: 'total', collection: null, id: null, bytes: 1_700_000, limit: 2_097_152, ratio: 0.81, severity: 'warn' };
    const ps = swarmKvSizeProblems({ warnings: [doc(0.97, 'crit'), total] });
    expect(ps.map((p) => [p.id, p.severity])).toEqual([
      ['swarm-kv-size/stack/shop', 'crit'],
      ['swarm-kv-size/total', 'warn'],
    ]);
    expect(ps[1]!.detail).toContain('1660.2 KB of 2048.0 KB (81%)');
  });
});
