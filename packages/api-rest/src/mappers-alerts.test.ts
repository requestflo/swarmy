import { describe, expect, it } from 'bun:test';
import {
  alertRuleToDto,
  createAlertRuleInput,
  createChannelInput,
  notificationChannelToDto,
  updateAlertRuleInput,
  updateChannelInput,
} from './mappers-alerts';

describe('alertRuleToDto', () => {
  it('maps camelCase view → snake_case DTO', () => {
    expect(
      alertRuleToDto({
        id: 'ar1', name: 'Disk', signal: 'disk-usage', selector: { server: 'wkr-1' }, mutedUntil: null,
        threshold: 90, forSeconds: 300, channelIds: ['ch1'], enabled: true, isDefault: false,
        createdAt: '2026-10-01T00:00:00.000Z',
      }),
    ).toEqual({
      id: 'ar1', name: 'Disk', signal: 'disk-usage', selector: { server: 'wkr-1' }, threshold: 90, for_seconds: 300,
      channel_ids: ['ch1'], enabled: true, is_default: false, muted_until: null, created_at: '2026-10-01T00:00:00.000Z',
    });
  });
});

describe('alert rule bodies → the tRPC inputs', () => {
  it('fills the same defaults as alerts.createRule', () => {
    expect(createAlertRuleInput({ name: 'Errors', signal: 'error-rate' })).toEqual({
      name: 'Errors', signal: 'error-rate', selector: {}, forSeconds: 0, channelIds: [], enabled: true,
    });
  });

  it('carries only the fields an update names (null clears the threshold)', () => {
    expect(updateAlertRuleInput('ar1', { threshold: null, channel_ids: [] })).toEqual({ id: 'ar1', threshold: null, channelIds: [] });
  });
});

describe('notificationChannelToDto', () => {
  it('maps the redacted view and never a destination', () => {
    expect(
      notificationChannelToDto({
        id: 'ch1', name: 'ops', kind: 'webhook', enabled: true, target: 'x.dev', hasSecret: true,
        createdAt: '2026-10-01T00:00:00.000Z',
      }),
    ).toEqual({
      id: 'ch1', name: 'ops', kind: 'webhook', enabled: true, target: 'x.dev', has_secret: true,
      created_at: '2026-10-01T00:00:00.000Z',
    });
  });
});

describe('channel bodies → the tRPC inputs', () => {
  it('maps snake_case destination fields and drops the ones a kind ignores', () => {
    expect(
      createChannelInput({ name: 'n', config: { kind: 'ntfy', server: 'https://ntfy.example.com', topic: 'ops', token: 'tk', to: 'x@y.z' } }),
    ).toEqual({ name: 'n', config: { kind: 'ntfy', server: 'https://ntfy.example.com', topic: 'ops', token: 'tk' } });
  });

  it('keeps the stored destination when an update leaves config out', () => {
    expect(updateChannelInput('ch1', { enabled: false })).toEqual({ id: 'ch1', enabled: false });
  });

  it('refuses what the core schema refuses (a short webhook secret)', () => {
    expect(() =>
      createChannelInput({ name: 'w', config: { kind: 'webhook', url: 'https://x.dev/h', secret: 'short' } }),
    ).toThrow(/secret/);
  });
});
