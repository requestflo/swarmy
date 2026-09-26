import { describe, expect, it } from 'bun:test';
import { ChannelConfigInput } from '@swarmy/core';
import {
  buildChannelRequest,
  channelTarget,
  DISCORD_COLORS,
  escapeTelegramMarkdownV2,
  gotifyPriority,
  ntfyPriority,
  ntfyTags,
  redactSecrets,
  renderDiscordBody,
  renderGotifyBody,
  renderNotificationSubject,
  renderNotificationText,
  renderNtfyBody,
  renderTelegramText,
  type AlertNotification,
} from './alerts-channels';
import { missingDefaultSignals, parseChannelConfig } from './alerts.service';

const firing: AlertNotification = {
  kind: 'firing',
  signal: 'disk-usage',
  severity: 'critical',
  resource: 'node:w1',
  message: 'Disk on w1 is 96.1% full (threshold 85%)',
  ruleName: null,
  at: '2026-09-24T10:00:00.000Z',
  eventId: 'evt_1',
};
const resolved: AlertNotification = { ...firing, kind: 'resolved', severity: 'info', message: 'recovered' };
const test: AlertNotification = { ...firing, kind: 'test', severity: 'info' };

const TG_TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';

describe('channel inputs (zod)', () => {
  it('accepts the new kinds and requires an ntfy server (no ntfy.sh default)', () => {
    expect(ChannelConfigInput.parse({ kind: 'discord', url: 'https://discord.com/api/webhooks/1/x' })).toEqual({
      kind: 'discord',
      url: 'https://discord.com/api/webhooks/1/x',
    });
    expect(ChannelConfigInput.safeParse({ kind: 'ntfy', topic: 'swarmy-alerts' }).success).toBe(false);
    expect(
      ChannelConfigInput.parse({ kind: 'ntfy', server: 'https://ntfy.example.com', topic: 'swarmy-alerts' }),
    ).toEqual({
      kind: 'ntfy',
      server: 'https://ntfy.example.com',
      topic: 'swarmy-alerts',
    });
    expect(ChannelConfigInput.safeParse({ kind: 'telegram', botToken: TG_TOKEN, chatId: '-100123' }).success).toBe(
      true,
    );
    expect(ChannelConfigInput.safeParse({ kind: 'telegram', botToken: 'nope', chatId: '1' }).success).toBe(false);
    expect(ChannelConfigInput.safeParse({ kind: 'ntfy', topic: 'bad topic/../x' }).success).toBe(false);
    expect(ChannelConfigInput.safeParse({ kind: 'gotify', server: 'https://g.example' }).success).toBe(false);
  });

  it('round-trips the stored (decrypted) blob of every new kind', () => {
    for (const c of [
      { kind: 'discord', url: 'https://discord.com/api/webhooks/1/x' },
      { kind: 'telegram', botToken: TG_TOKEN, chatId: '-100123', threadId: 7 },
      { kind: 'ntfy', server: 'https://ntfy.home.lan', topic: 'ops', token: 'tk_abc' },
      { kind: 'gotify', server: 'https://gotify.home.lan', token: 'AbCdEf' },
    ]) {
      expect(parseChannelConfig(JSON.stringify(c))).toEqual(c as never);
    }
    expect(parseChannelConfig(JSON.stringify({ kind: 'telegram', chatId: '1' }))).toBeNull();
    expect(parseChannelConfig(JSON.stringify({ kind: 'gotify', server: 'https://g' }))).toBeNull();
  });
});

describe('redacted targets never leak tokens', () => {
  it('shows chat id / host / host+topic only', () => {
    expect(channelTarget({ kind: 'telegram', botToken: TG_TOKEN, chatId: '-100123' })).toBe('chat -100123');
    expect(channelTarget({ kind: 'ntfy', server: 'https://ntfy.sh', topic: 'ops', token: 'tk' })).toBe('ntfy.sh/ops');
    expect(channelTarget({ kind: 'gotify', server: 'https://gotify.home.lan:8080', token: 'x' })).toBe(
      'gotify.home.lan:8080',
    );
    expect(channelTarget({ kind: 'discord', url: 'https://discord.com/api/webhooks/1/secret' })).toBe('discord.com');
  });

  it('scrubs secrets out of error detail', () => {
    expect(redactSecrets(`fetch https://api.telegram.org/bot${TG_TOKEN}/sendMessage failed`, [TG_TOKEN])).toBe(
      'fetch https://api.telegram.org/bot***/sendMessage failed',
    );
  });
});

describe('Discord embeds', () => {
  it('colours by severity, disables mentions, carries resource fields', () => {
    const body = renderDiscordBody(firing) as {
      allowed_mentions: unknown;
      embeds: Array<{ title: string; color: number; description: string; fields: Array<{ name: string; value: string; inline?: boolean }> }>;
    };
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.embeds[0]!.title).toBe('Disk almost full');
    expect(body.embeds[0]!.color).toBe(DISCORD_COLORS.critical);
    expect(body.embeds[0]!.fields[0]).toEqual({ name: 'Resource', value: 'node:w1', inline: true });
    const r = renderDiscordBody(resolved) as { embeds: Array<{ title: string; color: number }> };
    expect(r.embeds[0]!.title).toBe('Resolved: Disk almost full');
    expect(r.embeds[0]!.color).toBe(DISCORD_COLORS.resolved);
  });
});

describe('Telegram MarkdownV2', () => {
  it('escapes every reserved character', () => {
    expect(escapeTelegramMarkdownV2('a_b*c[d]e(f)g~h`i>j#k+l-m=n|o{p}q.r!s\\t')).toBe(
      'a\\_b\\*c\\[d\\]e\\(f\\)g\\~h\\`i\\>j\\#k\\+l\\-m\\=n\\|o\\{p\\}q\\.r\\!s\\\\t',
    );
  });

  it('renders a title, escaped message and resource line', () => {
    expect(renderTelegramText(firing)).toBe(
      '🔴 *Disk almost full*\nDisk on w1 is 96\\.1% full \\(threshold 85%\\)\n_node:w1_ · critical',
    );
  });

  it('builds a sendMessage request with the thread id and the token only in the URL', () => {
    const req = buildChannelRequest({ kind: 'telegram', botToken: TG_TOKEN, chatId: '-100123', threadId: 9 }, firing)!;
    expect(req.url).toBe(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`);
    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body.chat_id).toBe('-100123');
    expect(body.parse_mode).toBe('MarkdownV2');
    expect(body.message_thread_id).toBe(9);
    expect(req.body).not.toContain(TG_TOKEN);
    expect(req.secrets).toEqual([TG_TOKEN]);
  });
});

describe('ntfy + Gotify', () => {
  it('maps severity to ntfy priority and emoji tags', () => {
    expect(ntfyPriority(firing)).toBe(5);
    expect(ntfyPriority({ ...firing, severity: 'warning' })).toBe(4);
    expect(ntfyPriority(resolved)).toBe(2);
    expect(ntfyPriority(test)).toBe(3);
    expect(ntfyTags(firing)).toEqual(['rotating_light', 'disk-usage']);
    expect(ntfyTags(resolved)).toEqual(['white_check_mark', 'disk-usage']);
  });

  it('publishes JSON to the (self-hosted) server root with a bearer token', () => {
    const req = buildChannelRequest({ kind: 'ntfy', server: 'https://ntfy.home.lan/', topic: 'ops', token: 'tk_1' }, firing)!;
    expect(req.url).toBe('https://ntfy.home.lan');
    expect(req.headers.Authorization).toBe('Bearer tk_1');
    expect(JSON.parse(req.body)).toEqual({
      topic: 'ops',
      title: 'Disk almost full',
      message: 'Disk on w1 is 96.1% full (threshold 85%)\nnode:w1',
      priority: 5,
      tags: ['rotating_light', 'disk-usage'],
    });
    const anon = buildChannelRequest({ kind: 'ntfy', server: 'https://ntfy.sh', topic: 'ops' }, firing)!;
    expect(anon.headers.Authorization).toBeUndefined();
  });

  it('posts to gotify /message with the app token header', () => {
    const req = buildChannelRequest({ kind: 'gotify', server: 'https://g.home.lan', token: 'AbC' }, firing)!;
    expect(req.url).toBe('https://g.home.lan/message');
    expect(req.headers['X-Gotify-Key']).toBe('AbC');
    expect(JSON.parse(req.body).priority).toBe(8);
    expect(gotifyPriority(resolved)).toBe(2);
  });

  it('leaves email + generic webhook to the service transport', () => {
    expect(buildChannelRequest({ kind: 'email', to: 'a@b.dev' }, firing)).toBeNull();
    expect(buildChannelRequest({ kind: 'webhook', url: 'https://x.dev' }, firing)).toBeNull();
    expect(JSON.parse(buildChannelRequest({ kind: 'slack', url: 'https://hooks.slack.com/x' }, firing)!.body).text).toContain(
      'FIRING [critical] disk-usage on node:w1',
    );
  });
});

describe('default alerts: opt-out is permanent', () => {
  it('seeds every catalog signal once and never re-seeds a tombstoned default', () => {
    const all = missingDefaultSignals([]);
    for (const s of ['build-failed', 'deploy-failed', 'deploy-rolled-back', 'backup-failed', 'disk-usage', 'node-offline', 'cert-expiry', 'crash-loop']) {
      expect(all).toContain(s as never);
    }
    // A user-deleted default is still an isDefault row (tombstone) → counts as present.
    expect(missingDefaultSignals(all)).toEqual([]);
    expect(missingDefaultSignals(all.filter((s) => s !== 'crash-loop'))).toEqual(['crash-loop']);
  });
});

describe('summary notifications (weekly cost summary, owner decision Q6)', () => {
  const summary: AlertNotification = {
    kind: 'summary',
    signal: 'cost-weekly-summary',
    severity: 'info',
    resource: 'org:budget',
    message: '$214 of $300 this month (71%). On track to land at $214. Biggest: storefront $82.',
    ruleName: 'Weekly cost summary',
    at: '2026-09-28T09:00:00.000Z',
    eventId: null,
  };
  it('reads as one plain message, without alert chrome', () => {
    expect(renderNotificationText(summary)).toBe(
      'Weekly cost summary: $214 of $300 this month (71%). On track to land at $214. Biggest: storefront $82.',
    );
    expect(renderNotificationSubject(summary)).toBe('swarmy: weekly cost summary');
    expect(renderNtfyBody(summary, 'ops')).toMatchObject({ title: 'Weekly cost summary', message: summary.message, priority: 3 });
    expect(renderGotifyBody(summary)).toMatchObject({ title: 'Weekly cost summary', message: summary.message });
    expect(renderDiscordBody(summary).embeds).toMatchObject([{ title: 'Weekly cost summary', fields: [] }]);
  });
});
