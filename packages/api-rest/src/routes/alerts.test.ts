import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { decryptSecret } from '@swarmy/core/crypto';
import { AlertRuleDto, AlertRuleList } from '../dto-alerts';
import { NotificationChannelDto } from '../dto-channels';
import { testApp } from '../test-kit';
import { memTable } from '../test-mem';

/**
 * /alert-rules and /notification-channels ride alerts.service with the tRPC
 * guards: reads `read`, changes `write`, deletes the `alert.remove` policy
 * step. A channel's destination is stored vault-encrypted and never returned.
 */

const prevKey = process.env.SWARMY_SECRET_KEY;
beforeAll(() => {
  process.env.SWARMY_SECRET_KEY = 'test-vault-key-0123456789abcdef';
});
afterAll(() => {
  process.env.SWARMY_SECRET_KEY = prevKey;
});

function setup(opts: Parameters<typeof testApp>[0] = {}) {
  const alertRule = memTable('ar');
  const notificationChannel = memTable('ch');
  const t = testApp({ ...opts, models: { alertRule, notificationChannel } });
  return { ...t, rules: alertRule.rows, channels: notificationChannel.rows };
}

describe('alert rules', () => {
  it('lists the seeded defaults on first read', async () => {
    const t = setup({ scopes: ['read'] });
    const r = await t.call('GET', '/alert-rules');
    expect(r.status).toBe(200);
    expect(AlertRuleList.safeParse(r.json).success).toBe(true);
    expect(r.json.data.length).toBeGreaterThan(10);
    expect(r.json.data.every((x: { is_default: boolean }) => x.is_default)).toBe(true);
  });

  it('creates with the tRPC defaults, reads it back, patches and deletes it', async () => {
    const t = setup();
    const c = await t.call('POST', '/alert-rules', { name: 'Disk on wkr-1', signal: 'disk-usage', selector: { server: 'wkr-1' }, threshold: 92.5 });
    expect(c.status).toBe(201);
    expect(AlertRuleDto.safeParse(c.json).success).toBe(true);
    expect(c.json).toMatchObject({ name: 'Disk on wkr-1', for_seconds: 0, channel_ids: [], enabled: true, is_default: false });
    const id = c.json.id as string;

    expect((await t.call('GET', `/alert-rules/${id}`)).json.selector).toEqual({ server: 'wkr-1' });
    const p = await t.call('PATCH', `/alert-rules/${id}`, { threshold: null, for_seconds: 600 });
    expect(p.json).toMatchObject({ threshold: null, for_seconds: 600, name: 'Disk on wkr-1' });

    const d = await t.call('DELETE', `/alert-rules/${id}`);
    expect(d.json).toEqual({ id, removed: true });
    expect((await t.call('GET', `/alert-rules/${id}`)).status).toBe(404);
    expect(t.actions()).toEqual(['alerts.createRule', 'alerts.updateRule', 'authz.permit:alert.remove', 'alerts.deleteRule']);
  });

  it('refuses a target the signal cannot take, as the dashboard does (400)', async () => {
    const r = await setup().call('POST', '/alert-rules', { name: 'x', signal: 'node-offline', selector: { app: 'shop' } });
    expect(r.status).toBe(400);
  });

  it('replays a create sent twice with one Idempotency-Key', async () => {
    const t = setup();
    const body = { name: 'Errors', signal: 'error-rate', selector: { app: 'shop' } };
    const a = await t.call('POST', '/alert-rules', body, { 'idempotency-key': 'k-1' });
    const b = await t.call('POST', '/alert-rules', body, { 'idempotency-key': 'k-1' });
    expect(b.headers.get('idempotency-replayed')).toBe('true');
    expect(b.json.id).toBe(a.json.id);
    expect(t.rules.filter((r) => r.name === 'Errors')).toHaveLength(1);
  });

  it('a read key cannot write (403)', async () => {
    const r = await setup({ scopes: ['read'] }).call('POST', '/alert-rules', { name: 'x', signal: 'disk-usage' });
    expect(r.status).toBe(403);
  });
});

describe('notification channels', () => {
  it('stores the destination encrypted and never returns it', async () => {
    const t = setup();
    const url = 'https://hooks.slack.com/services/T0/B0/very-secret';
    const c = await t.call('POST', '/notification-channels', { name: 'ops', config: { kind: 'slack', url } });
    expect(c.status).toBe(201);
    expect(NotificationChannelDto.safeParse(c.json).success).toBe(true);
    expect(JSON.stringify(c.json)).not.toContain('very-secret');
    expect(c.json).toMatchObject({ kind: 'slack', enabled: true, target: 'hooks.slack.com', has_secret: false });
    const stored = t.channels[0]!.configEnc as string;
    expect(stored).not.toContain('very-secret');
    expect(JSON.parse(decryptSecret(stored))).toEqual({ kind: 'slack', url });

    const list = await t.call('GET', '/notification-channels');
    expect(JSON.stringify(list.json)).not.toContain('very-secret');
  });

  it('maps snake_case destination fields to the core config (telegram)', async () => {
    const t = setup();
    const config = { kind: 'telegram', bot_token: '123456:ABCDEFGHIJKLMNOPQRSTUVWX', chat_id: '-1001', thread_id: 7 };
    const c = await t.call('POST', '/notification-channels', { name: 'tg', config });
    expect(c.json.has_secret).toBe(true);
    expect(JSON.parse(decryptSecret(t.channels[0]!.configEnc as string))).toEqual({
      kind: 'telegram', botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWX', chatId: '-1001', threadId: 7,
    });
  });

  it('refuses a destination the kind cannot take (400) and a kind change (400)', async () => {
    const t = setup();
    expect((await t.call('POST', '/notification-channels', { name: 'x', config: { kind: 'email', to: 'nope' } })).status).toBe(400);
    const c = await t.call('POST', '/notification-channels', { name: 'm', config: { kind: 'email', to: 'ops@example.com' } });
    const p = await t.call('PATCH', `/notification-channels/${c.json.id}`, { config: { kind: 'slack', url: 'https://x.dev/h' } });
    expect(p.status).toBe(400);
  });

  it('disables, renames and deletes through the alert.remove step', async () => {
    const t = setup();
    const c = await t.call('POST', '/notification-channels', { name: 'm', config: { kind: 'email', to: 'ops@example.com' } });
    const p = await t.call('PATCH', `/notification-channels/${c.json.id}`, { enabled: false, name: 'mail' });
    expect(p.json).toMatchObject({ enabled: false, name: 'mail', target: 'ops@example.com' });
    expect((await t.call('DELETE', `/notification-channels/${c.json.id}`)).json.removed).toBe(true);
    expect(t.actions()).toContain('authz.permit:alert.remove');
    expect((await t.call('GET', `/notification-channels/${c.json.id}`)).status).toBe(404);
  });
});
