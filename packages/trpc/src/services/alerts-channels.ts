import {
  renderDiscordBody,
  renderGotifyBody,
  renderNotificationText,
  renderNtfyBody,
  renderTelegramBody,
  type AlertNotification,
  type ChannelConfigInput,
} from '@swarmy/core';

/**
 * Per-channel notification delivery plans (pure, unit-tested).
 * `alerts.service.ts` owns the transport (`fetch`, email outbox); WHAT each
 * channel kind receives is rendered by `@swarmy/core` (alert-render*.ts) —
 * shared with the dashboard's "Send test" preview, so the preview is exactly
 * what is sent — and re-exported here for the controller's callers.
 *
 * Secrets (Telegram bot token, ntfy/gotify tokens) only ever ride the request —
 * `redactSecrets` scrubs them out of any detail string surfaced to the user.
 */

export {
  DISCORD_COLORS,
  escapeTelegramMarkdownV2,
  gotifyPriority,
  notificationTitle,
  ntfyPriority,
  ntfyTags,
  renderDiscordBody,
  renderGotifyBody,
  renderNotificationSubject,
  renderNotificationText,
  renderNtfyBody,
  renderTelegramBody,
  renderTelegramText,
  type AlertNotification,
} from '@swarmy/core';

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
