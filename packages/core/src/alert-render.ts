import { ALERT_SIGNAL_INFO, type AlertSeverityView, type AlertSignal } from './views';

/**
 * What a notification channel receives — pure and browser-safe, so the
 * controller sends exactly what the dashboard's "Send test" preview shows.
 * The controller (`@swarmy/trpc` alerts-channels.ts / alerts.service.ts) owns
 * the transport; this module owns the words. Per-app shapes (Discord embed,
 * Telegram MarkdownV2, ntfy, Gotify) live in `alert-render-apps.ts`.
 *
 *   slack / teams  `{ text }` one-liner (incoming-webhook shape)
 *   email          subject + the same one-liner
 *   webhook        `{ event }` JSON, HMAC-signed when the channel has a secret
 */

export interface AlertNotification {
  /** `summary` = a plain scheduled message (the weekly cost summary), no alert chrome. */
  kind: 'firing' | 'resolved' | 'test' | 'summary';
  signal: string;
  severity: AlertSeverityView;
  resource: string;
  message: string;
  ruleName: string | null;
  /** ISO timestamp of the transition. */
  at: string;
  eventId: string | null;
}

/** Signature header on generic webhook deliveries (webhooks-out scheme). */
export const ALERT_SIGNATURE_HEADER = 'X-Swarmy-Signature';

/** The notification "Send test" delivers (`alerts.testChannel`). */
export function testNotification(at: string): AlertNotification {
  return {
    kind: 'test',
    signal: 'test',
    severity: 'info',
    resource: 'channel-test',
    message: 'Test notification from swarmy.',
    ruleName: null,
    at,
    eventId: null,
  };
}

/** One-line text rendering shared by slack/teams/email deliveries. */
export function renderNotificationText(n: AlertNotification): string {
  if (n.kind === 'test') {
    return `swarmy test notification — if you can read this, the channel works. (${n.at})`;
  }
  if (n.kind === 'summary') return `${n.ruleName ?? 'swarmy'}: ${n.message}`;
  const head = n.kind === 'firing' ? `🔥 FIRING [${n.severity}]` : `✅ RESOLVED`;
  const rule = n.ruleName ? ` · rule "${n.ruleName}"` : '';
  return `${head} ${n.signal} on ${n.resource} — ${n.message}${rule} (${n.at})`;
}

/** Email subject line for a notification. */
export function renderNotificationSubject(n: AlertNotification): string {
  if (n.kind === 'test') return 'swarmy: test notification';
  if (n.kind === 'summary') return `swarmy: ${(n.ruleName ?? 'summary').toLowerCase()}`;
  const head = n.kind === 'firing' ? `[${n.severity.toUpperCase()}]` : '[RESOLVED]';
  return `swarmy ${head} ${n.signal}: ${n.resource}`;
}

/** Human title: the rule name, else the catalog label, else the raw signal. */
export function notificationTitle(n: AlertNotification): string {
  if (n.kind === 'test') return 'swarmy test notification';
  if (n.kind === 'summary') return n.ruleName ?? 'swarmy';
  const label =
    n.ruleName ?? ALERT_SIGNAL_INFO[n.signal as AlertSignal]?.label ?? n.signal;
  return n.kind === 'resolved' ? `Resolved: ${label}` : label;
}

/** The body line under the title (test / summary have no alert detail). */
export function notificationBody(n: AlertNotification): string {
  if (n.kind === 'test') return 'If you can read this, the channel works.';
  return n.message;
}

/** The generic webhook's JSON body (signed over exactly this string). */
export function renderWebhookBody(n: AlertNotification): string {
  return JSON.stringify({ event: n });
}
