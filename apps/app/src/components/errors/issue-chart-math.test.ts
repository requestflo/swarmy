import { describe, expect, test } from 'bun:test';
import type { AlertRuleView, NotificationChannelView, ReleaseView } from '@swarmy/core';
import { rollbackTarget, spikeChannels, trendPosition } from './issue-chart-math';

const H = 3_600_000;
const NOW = Date.UTC(2026, 9, 23, 14, 30);

describe('trendPosition', () => {
  test('the window starts 23 whole hours before the current hour', () => {
    expect(trendPosition(new Date(Date.UTC(2026, 9, 22, 15, 0)).toISOString(), NOW)).toBe(0);
    expect(trendPosition(new Date(NOW).toISOString(), NOW)).toBeCloseTo(23.5 / 24);
  });
  test('before the window is null; unset is null', () => {
    expect(trendPosition(new Date(NOW - 30 * H).toISOString(), NOW)).toBeNull();
    expect(trendPosition(null, NOW)).toBeNull();
  });
});

const rel = (id: string, status: ReleaseView['status']): ReleaseView => ({
  id,
  stackName: 'storefront',
  status,
  images: [{ name: 'web', image: `ghcr.io/northwind/web:${id}` }],
  actor: null,
  strategy: null,
  healthGate: null,
  notes: null,
  createdAt: new Date(NOW).toISOString(),
});

describe('rollbackTarget', () => {
  const rows = [rel('6', 'deploying'), rel('5', 'failed'), rel('4', 'healthy')];
  test('the running release introduced it → the newest earlier good one', () => {
    expect(rollbackTarget(rows, '6')?.id).toBe('4');
  });
  test('an older release introduced it, or none is linked → nothing to put back', () => {
    expect(rollbackTarget(rows, '4')).toBeNull();
    expect(rollbackTarget(rows, null)).toBeNull();
  });
  test('a head that already failed is not running', () => {
    expect(rollbackTarget([rel('6', 'failed'), rel('4', 'healthy')], '6')).toBeNull();
  });
});

describe('spikeChannels', () => {
  const ch = (id: string, enabled = true): NotificationChannelView => ({ id, name: id, kind: 'slack', enabled, target: 'x', hasSecret: false, createdAt: '' });
  const rule = (over: Partial<AlertRuleView>): AlertRuleView => ({
    id: 'r', name: 'r', signal: 'error-spike', selector: {}, mutedUntil: null, threshold: null, forSeconds: 0,
    channelIds: [], enabled: true, isDefault: true, createdAt: '', ...over,
  });
  test('enabled, unmuted spike rules covering the app name their channels', () => {
    const out = spikeChannels(
      [
        rule({ channelIds: ['slack'] }),
        rule({ selector: { app: 'blog' }, channelIds: ['blog'] }),
        rule({ signal: 'error-rate', channelIds: ['rate'] }),
        rule({ mutedUntil: new Date(NOW + H).toISOString(), channelIds: ['muted'] }),
        rule({ channelIds: ['off'] }),
      ],
      [ch('slack'), ch('blog'), ch('rate'), ch('muted'), ch('off', false)],
      'storefront',
      NOW,
    );
    expect(out.rules).toBe(2);
    expect(out.channels.map((c) => c.id)).toEqual(['slack']);
  });
});
