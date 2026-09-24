import { ALERT_SIGNAL_INFO, type AlertSeverityView, type AlertSignal, type ChannelConfigInput } from '@swarmy/core';

/**
 * Per-channel notification rendering (pure, unit-tested). `alerts.service.ts`
 * owns the transport (`fetch`, email outbox); this module owns WHAT each
 * channel kind receives:
 *
 *   slack / teams  `{ text }` one-liner (incoming-webhook shape)
 *   discord        an embed coloured by severity; mentions disabled
 *   telegram       Bot API `sendMessage` with MarkdownV2 (every reserved char escaped)
 *   ntfy           JSON publish to the server root (topic/title/priority/tags)
 *   gotify         `POST /message` with the app token header + priority
 *
 * Secrets (Telegram bot token, ntfy/gotify tokens) only ever ride the request —
 * `redactSecrets` scrubs them out of any detail string surfaced to the user.
 */

export interface AlertNotification {
  kind: 'firing' | 'resolved' | 'test';
  signal: string;
  severity: AlertSeverityView;
  resource: string;
  message: string;
  ruleName: string | null;
  /** ISO timestamp of the transition. */
  at: string;
  eventId: string | null;
}

/** One-line text rendering shared by slack/teams/email deliveries. */
export function renderNotificationText(n: AlertNotification): string {
  if (n.kind === 'test') {
    return `swarmy test notification — if you can read this, the channel works. (${n.at})`;
  }
  const head = n.kind === 'firing' ? `🔥 FIRING [${n.severity}]` : `✅ RESOLVED`;
  const rule = n.ruleName ? ` · rule "${n.ruleName}"` : '';
  return `${head} ${n.signal} on ${n.resource} — ${n.message}${rule} (${n.at})`;
}

/** Email subject line for a notification. */
export function renderNotificationSubject(n: AlertNotification): string {
  if (n.kind === 'test') return 'swarmy: test notification';
  const head = n.kind === 'firing' ? `[${n.severity.toUpperCase()}]` : '[RESOLVED]';
  return `swarmy ${head} ${n.signal}: ${n.resource}`;
}

/** Human title: the rule name, else the catalog label, else the raw signal. */
export function notificationTitle(n: AlertNotification): string {
  if (n.kind === 'test') return 'swarmy test notification';
  const label =
    n.ruleName ?? ALERT_SIGNAL_INFO[n.signal as AlertSignal]?.label ?? n.signal;
  return n.kind === 'resolved' ? `Resolved: ${label}` : label;
}

function notificationBody(n: AlertNotification): string {
  if (n.kind === 'test') return 'If you can read this, the channel works.';
  return n.message;
}

// ── Discord ───────────────────────────────────────────────────────────────────

/** Embed colours (decimal RGB): resolved green, info blue, warning amber, critical red. */
export const DISCORD_COLORS = {
  resolved: 0x2e9e5b,
  info: 0x3b82f6,
  warning: 0xf5a524,
  critical: 0xe5484d,
} as const;

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export function renderDiscordBody(n: AlertNotification): Record<string, unknown> {
  const color =
    n.kind === 'resolved' || n.kind === 'test' ? DISCORD_COLORS.resolved : DISCORD_COLORS[n.severity];
  const fields =
    n.kind === 'test'
      ? []
      : [
          { name: 'Resource', value: clip(n.resource, 1024), inline: true },
          { name: 'Severity', value: n.kind === 'resolved' ? 'resolved' : n.severity, inline: true },
          { name: 'Signal', value: clip(n.signal, 1024), inline: true },
        ];
  return {
    username: 'swarmy',
    // Never let an alert message ping @everyone / roles / users.
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: clip(notificationTitle(n), 256),
        description: clip(notificationBody(n), 4096),
        color,
        fields,
        timestamp: n.at,
        footer: { text: 'swarmy' },
      },
    ],
  };
}

// ── Telegram (MarkdownV2) ─────────────────────────────────────────────────────

/**
 * Escape text for Telegram MarkdownV2. Every one of
 * `_ * [ ] ( ) ~ \` > # + - = | { } . !` and the backslash itself must be
 * preceded by `\` outside of entities, or the Bot API rejects the message.
 */
export function escapeTelegramMarkdownV2(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`);
}

export function renderTelegramText(n: AlertNotification): string {
  const e = escapeTelegramMarkdownV2;
  if (n.kind === 'test') return `*${e('swarmy test notification')}*\n${e(notificationBody(n))}`;
  const icon = n.kind === 'firing' ? (n.severity === 'critical' ? '🔴' : n.severity === 'warning' ? '🟠' : '🔵') : '✅';
  const lines = [
    `${icon} *${e(notificationTitle(n))}*`,
    e(clip(n.message, 3500)),
    `_${e(n.resource)}_ · ${e(n.kind === 'resolved' ? 'resolved' : n.severity)}`,
  ];
  return lines.join('\n');
}

export function renderTelegramBody(
  n: AlertNotification,
  config: { chatId: string; threadId?: number },
): Record<string, unknown> {
  return {
    chat_id: config.chatId,
    text: renderTelegramText(n),
    parse_mode: 'MarkdownV2',
    disable_web_page_preview: true,
    ...(config.threadId ? { message_thread_id: config.threadId } : {}),
  };
}

// ── ntfy ──────────────────────────────────────────────────────────────────────

/** ntfy priority 1..5 (min, low, default, high, urgent). */
export function ntfyPriority(n: AlertNotification): 1 | 2 | 3 | 4 | 5 {
  if (n.kind === 'test') return 3;
  if (n.kind === 'resolved') return 2;
  return n.severity === 'critical' ? 5 : n.severity === 'warning' ? 4 : 3;
}

/** ntfy tags: an emoji shortcode first (rendered as the icon), then the signal. */
export function ntfyTags(n: AlertNotification): string[] {
  if (n.kind === 'test') return ['white_check_mark', 'swarmy'];
  if (n.kind === 'resolved') return ['white_check_mark', n.signal];
  const emoji = n.severity === 'critical' ? 'rotating_light' : n.severity === 'warning' ? 'warning' : 'information_source';
  return [emoji, n.signal];
}

export function renderNtfyBody(n: AlertNotification, topic: string): Record<string, unknown> {
  return {
    topic,
    title: notificationTitle(n),
    message: n.kind === 'test' ? notificationBody(n) : `${n.message}\n${n.resource}`,
    priority: ntfyPriority(n),
    tags: ntfyTags(n),
  };
}

// ── Gotify ────────────────────────────────────────────────────────────────────

/** Gotify priority 0..10 — ≥8 is the "high" band clients pop as urgent. */
export function gotifyPriority(n: AlertNotification): number {
  if (n.kind === 'test') return 5;
  if (n.kind === 'resolved') return 2;
  return n.severity === 'critical' ? 8 : n.severity === 'warning' ? 5 : 3;
}

export function renderGotifyBody(n: AlertNotification): Record<string, unknown> {
  return {
    title: notificationTitle(n),
    message: n.kind === 'test' ? notificationBody(n) : `${n.message}\n${n.resource}`,
    priority: gotifyPriority(n),
  };
}

// ── The request plan (URL + headers + body) per HTTP channel kind ─────────────

export interface ChannelRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  /** Secret values present in the URL/headers — scrubbed from any detail text. */
  secrets: string[];
}

const trimSlash = (u: string): string => u.replace(/\/+$/, '');

/**
 * Build the HTTP request for a push-style channel. Returns null for kinds the
 * service delivers another way (email outbox, HMAC-signed generic webhook).
 */
export function buildChannelRequest(
  config: ChannelConfigInput,
  n: AlertNotification,
): ChannelRequest | null {
  const json = { 'Content-Type': 'application/json' };
  switch (config.kind) {
    case 'slack':
    case 'teams':
      return {
        url: config.url,
        headers: json,
        body: JSON.stringify({ text: renderNotificationText(n) }),
        secrets: [config.url],
      };
    case 'discord':
      return { url: config.url, headers: json, body: JSON.stringify(renderDiscordBody(n)), secrets: [config.url] };
    case 'telegram':
      return {
        url: `https://api.telegram.org/bot${config.botToken}/sendMessage`,
        headers: json,
        body: JSON.stringify(renderTelegramBody(n, config)),
        secrets: [config.botToken],
      };
    case 'ntfy':
      return {
        // JSON publishing goes to the server ROOT (topic rides the body) — no
        // non-ASCII header encoding to worry about for titles.
        url: trimSlash(config.server),
        headers: { ...json, ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}) },
        body: JSON.stringify(renderNtfyBody(n, config.topic)),
        secrets: config.token ? [config.token] : [],
      };
    case 'gotify':
      return {
        url: `${trimSlash(config.server)}/message`,
        headers: { ...json, 'X-Gotify-Key': config.token },
        body: JSON.stringify(renderGotifyBody(n)),
        secrets: [config.token],
      };
    default:
      return null;
  }
}

/** Scrub secret values out of a detail string before it reaches a client. */
export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join('***');
  return out;
}

/**
 * Redacted destination for the view: an email address, the URL host, a
 * Telegram chat, or an ntfy `host/topic` — never a token or a full webhook URL
 * (slack/teams/discord webhook paths are secrets).
 */
export function channelTarget(config: ChannelConfigInput | null): string {
  if (!config) return 'unconfigured';
  if (config.kind === 'email') return config.to;
  if (config.kind === 'telegram') return `chat ${config.chatId}`;
  const raw = config.kind === 'ntfy' || config.kind === 'gotify' ? config.server : config.url;
  try {
    const host = new URL(raw).host;
    return config.kind === 'ntfy' ? `${host}/${config.topic}` : host;
  } catch {
    return 'invalid URL';
  }
}
