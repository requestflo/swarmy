/**
 * Notification dispatch worker (spine stub — owned by slice F6 notifications).
 *
 * Will drain queued `NotificationDelivery` rows each tick and send via the
 * org's provider (resend/postmark/mailgun REST via fetch; smtp via nodemailer)
 * with retry/backoff, recording status transitions. Inert until F6 fills in
 * the tick body.
 */

const TICK_MS = 30_000;

export function startNotificationDispatch(): () => void {
  const timer = setInterval(() => {
    // Inert spine stub: slice F6 (notifications) implements the dispatch tick.
  }, TICK_MS);
  return () => clearInterval(timer);
}
