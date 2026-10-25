import { B, list, runCases } from './harness.js';

const rule = {
  id: 'ar 1', name: 'Disk', signal: 'disk-usage', selector: { server: 'wkr-1' }, threshold: 90.5, for_seconds: 300,
  channel_ids: ['ch1'], enabled: true, is_default: false, muted_until: null, created_at: '2026-10-01T00:00:00.000Z',
};
const channel = {
  id: 'ch1', name: 'ops', kind: 'slack', enabled: true, target: 'hooks.slack.com', has_secret: false,
  created_at: '2026-10-01T00:00:00.000Z',
};

runCases('alert rules and notification channels', [
  { name: 'alertRules.list', call: (c) => c.alertRules.list(), response: list([rule]),
    request: `GET ${B}/alert-rules`, check: (o) => o.data[0].threshold, want: 90.5 },
  { name: 'alertRules.get', call: (c) => c.alertRules.get('ar 1'), response: rule,
    request: `GET ${B}/alert-rules/ar%201`, check: (o) => o.selector.server, want: 'wkr-1' },
  { name: 'alertRules.create',
    call: (c) => c.alertRules.create({ name: 'Disk', signal: 'disk-usage', selector: { server: 'wkr-1' }, threshold: 90.5 }),
    response: rule, status: 201, request: `POST ${B}/alert-rules`,
    body: { name: 'Disk', signal: 'disk-usage', selector: { server: 'wkr-1' }, threshold: 90.5 }, check: (o) => o.id, want: 'ar 1' },
  { name: 'alertRules.update', call: (c) => c.alertRules.update('ar1', { threshold: null, enabled: false }),
    response: { ...rule, threshold: null, enabled: false }, request: `PATCH ${B}/alert-rules/ar1`,
    body: { threshold: null, enabled: false }, check: (o) => o.enabled, want: false },
  { name: 'alertRules.remove', call: (c) => c.alertRules.remove('ar1'), response: { id: 'ar1', removed: true },
    request: `DELETE ${B}/alert-rules/ar1`, check: (o) => o.removed, want: true },

  { name: 'notificationChannels.list', call: (c) => c.notificationChannels.list(), response: list([channel]),
    request: `GET ${B}/notification-channels`, check: (o) => o.data[0].target, want: 'hooks.slack.com' },
  { name: 'notificationChannels.get', call: (c) => c.notificationChannels.get('ch 1'), response: channel,
    request: `GET ${B}/notification-channels/ch%201`, check: (o) => o.kind, want: 'slack' },
  { name: 'notificationChannels.create',
    call: (c) => c.notificationChannels.create({ name: 'ops', config: { kind: 'slack', url: 'https://hooks.slack.com/x' } }),
    response: channel, status: 201, request: `POST ${B}/notification-channels`,
    body: { name: 'ops', config: { kind: 'slack', url: 'https://hooks.slack.com/x' } }, check: (o) => o.has_secret, want: false },
  { name: 'notificationChannels.update', call: (c) => c.notificationChannels.update('ch1', { enabled: false }),
    response: { ...channel, enabled: false }, request: `PATCH ${B}/notification-channels/ch1`,
    body: { enabled: false }, check: (o) => o.enabled, want: false },
  { name: 'notificationChannels.remove', call: (c) => c.notificationChannels.remove('ch1'), response: { id: 'ch1', removed: true },
    request: `DELETE ${B}/notification-channels/ch1`, check: (o) => o.removed, want: true },
]);
