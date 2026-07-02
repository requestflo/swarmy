import type { OrgContext } from '../context';

/**
 * Notification send helper (slice F6) — the one entry point other slices use
 * to send an email-style notification (enqueues a `NotificationDelivery`; the
 * notification-dispatch worker delivers via the org's configured provider).
 * Used by alerts (C3), and exposed to apps via `POST /v1/notify`.
 *
 * Spine stub — a no-op until F6 implements it; callers compile now.
 */

/** Queue a notification for delivery via the org's provider. */
export async function sendNotification(
  _ctx: OrgContext,
  _input: {
    to: string;
    subject: string;
    bodyText?: string;
    bodyHtml?: string;
    template?: string;
    vars?: Record<string, string>;
  },
): Promise<void> {}
