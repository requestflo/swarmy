import { notificationBody, notificationTitle, type AlertNotification } from './alert-render';

/**
 * The per-app payloads (pure, browser-safe — the dashboard previews them):
 *
 *   discord   an embed coloured by severity; mentions disabled
 *   telegram  Bot API `sendMessage` with MarkdownV2 (every reserved char escaped)
 *   ntfy      JSON publish to the server root (topic/title/priority/tags)
 *   gotify    `POST /message` with the app token header + priority
 */

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
    n.kind === 'summary'
      ? DISCORD_COLORS.info
      : n.kind === 'resolved' || n.kind === 'test'
        ? DISCORD_COLORS.resolved
        : DISCORD_COLORS[n.severity];
  const fields =
    n.kind === 'test' || n.kind === 'summary'
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
  if (n.kind === 'test' || n.kind === 'summary') return `*${e(notificationTitle(n))}*\n${e(notificationBody(n))}`;
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
  if (n.kind === 'test' || n.kind === 'summary') return 3;
  if (n.kind === 'resolved') return 2;
  return n.severity === 'critical' ? 5 : n.severity === 'warning' ? 4 : 3;
}

/** ntfy tags: an emoji shortcode first (rendered as the icon), then the signal. */
export function ntfyTags(n: AlertNotification): string[] {
  if (n.kind === 'test') return ['white_check_mark', 'swarmy'];
  if (n.kind === 'summary') return ['moneybag', 'swarmy'];
  if (n.kind === 'resolved') return ['white_check_mark', n.signal];
  const emoji = n.severity === 'critical' ? 'rotating_light' : n.severity === 'warning' ? 'warning' : 'information_source';
  return [emoji, n.signal];
}

export function renderNtfyBody(n: AlertNotification, topic: string): Record<string, unknown> {
  return {
    topic,
    title: notificationTitle(n),
    message: n.kind === 'test' || n.kind === 'summary' ? notificationBody(n) : `${n.message}\n${n.resource}`,
    priority: ntfyPriority(n),
    tags: ntfyTags(n),
  };
}

// ── Gotify ────────────────────────────────────────────────────────────────────

/** Gotify priority 0..10 — ≥8 is the "high" band clients pop as urgent. */
export function gotifyPriority(n: AlertNotification): number {
  if (n.kind === 'test' || n.kind === 'summary') return 5;
  if (n.kind === 'resolved') return 2;
  return n.severity === 'critical' ? 8 : n.severity === 'warning' ? 5 : 3;
}

export function renderGotifyBody(n: AlertNotification): Record<string, unknown> {
  return {
    title: notificationTitle(n),
    message: n.kind === 'test' || n.kind === 'summary' ? notificationBody(n) : `${n.message}\n${n.resource}`,
    priority: gotifyPriority(n),
  };
}
