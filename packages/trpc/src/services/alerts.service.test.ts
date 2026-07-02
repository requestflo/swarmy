import { describe, expect, it } from 'bun:test';
import { ALERT_SIGNALS, ALERT_SIGNAL_INFO } from '@swarmy/core';
import {
  channelTarget,
  parseChannelConfig,
  parseChannelIds,
  renderNotificationSubject,
  renderNotificationText,
  type AlertNotification,
} from './alerts.service';

const firing: AlertNotification = {
  kind: 'firing',
  signal: 'disk-usage',
  severity: 'warning',
  resource: 'node:w1',
  message: 'Disk on w1 is 84.2% full (threshold 80%)',
  ruleName: 'Disk almost full',
  at: '2026-07-02T10:00:00.000Z',
  eventId: 'evt_1',
};

describe('channel config codec', () => {
  it('round-trips every kind and drops malformed blobs', () => {
    expect(parseChannelConfig(JSON.stringify({ kind: 'email', to: 'ops@acme.dev' }))).toEqual({
      kind: 'email',
      to: 'ops@acme.dev',
    });
    expect(
      parseChannelConfig(JSON.stringify({ kind: 'slack', url: 'https://hooks.slack.com/services/T/B/x' })),
    ).toEqual({ kind: 'slack', url: 'https://hooks.slack.com/services/T/B/x' });
    expect(
      parseChannelConfig(JSON.stringify({ kind: 'webhook', url: 'https://x.dev/h', secret: 's3cret-s3cret' })),
    ).toEqual({ kind: 'webhook', url: 'https://x.dev/h', secret: 's3cret-s3cret' });
    // webhook without secret omits the key entirely
    expect(parseChannelConfig(JSON.stringify({ kind: 'webhook', url: 'https://x.dev/h' }))).toEqual({
      kind: 'webhook',
      url: 'https://x.dev/h',
    });
    expect(parseChannelConfig('not json')).toBeNull();
    expect(parseChannelConfig(JSON.stringify({ kind: 'pager', to: 'x' }))).toBeNull();
    expect(parseChannelConfig(JSON.stringify({ kind: 'email' }))).toBeNull();
  });

  it('redacts targets: email address, URL host only (webhook paths are secrets)', () => {
    expect(channelTarget({ kind: 'email', to: 'ops@acme.dev' })).toBe('ops@acme.dev');
    expect(channelTarget({ kind: 'slack', url: 'https://hooks.slack.com/services/T0/B0/zzz' })).toBe(
      'hooks.slack.com',
    );
    expect(channelTarget({ kind: 'webhook', url: 'https://alerts.acme.dev:8443/hook?k=v' })).toBe(
      'alerts.acme.dev:8443',
    );
    expect(channelTarget(null)).toBe('unconfigured');
    expect(channelTarget({ kind: 'teams', url: 'not a url' })).toBe('invalid URL');
  });
});

describe('notification rendering', () => {
  it('renders firing / resolved / test lines', () => {
    expect(renderNotificationText(firing)).toContain('FIRING [warning] disk-usage on node:w1');
    expect(renderNotificationText(firing)).toContain('rule "Disk almost full"');
    expect(
      renderNotificationText({ ...firing, kind: 'resolved', message: 'recovered' }),
    ).toContain('RESOLVED disk-usage on node:w1 — recovered');
    expect(renderNotificationText({ ...firing, kind: 'test' })).toContain('test notification');
  });

  it('renders subjects with severity for firing, RESOLVED otherwise', () => {
    expect(renderNotificationSubject(firing)).toBe('swarmy [WARNING] disk-usage: node:w1');
    expect(renderNotificationSubject({ ...firing, kind: 'resolved' })).toBe(
      'swarmy [RESOLVED] disk-usage: node:w1',
    );
  });
});

describe('rule helpers', () => {
  it('parseChannelIds keeps only strings', () => {
    expect(parseChannelIds(['a', 1, null, 'b'])).toEqual(['a', 'b']);
    expect(parseChannelIds('nope')).toEqual([]);
    expect(parseChannelIds(undefined)).toEqual([]);
  });

  it('the default-rule catalog covers every known signal', () => {
    for (const signal of ALERT_SIGNALS) {
      const info = ALERT_SIGNAL_INFO[signal];
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.defaultForSeconds).toBeGreaterThanOrEqual(0);
      // A unit implies a threshold and vice versa.
      expect(info.unit === null).toBe(info.defaultThreshold === null);
    }
  });
});
