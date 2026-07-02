import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import { sendNotification, writeAudit } from '@swarmy/trpc';
import type { RestEnv } from '../middleware';
import { requireScope } from '../middleware';
import { ProblemDto } from '../dto';
import { run } from '../respond';

/**
 * Notification relay REST route (`POST /v1/notify`) — slice F6.
 *
 * Lets any app with a write-scoped API key send an email through the org's
 * configured provider. The call only ENQUEUES a `NotificationDelivery` row;
 * the notification-dispatch worker (apps/api) does the provider send with
 * retry/backoff, so this returns 202.
 */

const NotifyBody = z
  .object({
    to: z.string().trim().email().max(254).openapi({ example: 'ops@example.com' }),
    subject: z.string().trim().min(1).max(200).openapi({ example: 'Deploy finished' }),
    /** Plain-text body. Optional when `template` is set. */
    body: z.string().max(20_000).optional(),
    /** Optional HTML body (sent alongside `body` as the text part). */
    html: z.string().max(50_000).optional(),
    /** Name of a saved notification template to render. */
    template: z.string().trim().min(1).max(60).optional(),
    /** `{{var}}` values for the template (HTML-escaped in the HTML body). */
    vars: z.record(z.string().max(2_000)).optional(),
  })
  .openapi('NotifyBody');

const NotifyQueuedDto = z
  .object({
    queued: z.literal(true),
    to: z.string(),
  })
  .openapi('NotifyQueued');

const problemRes = {
  content: { 'application/problem+json': { schema: ProblemDto } },
  description: 'Problem',
};

/** Notification relay routes. */
export function registerNotifyRoutes(app: OpenAPIHono<RestEnv>): void {
  app.openapi(
    createRoute({
      method: 'post',
      path: '/notify',
      tags: ['Notifications'],
      summary: 'Send an email via the org’s configured provider',
      description:
        'Queues the message on the org’s notification outbox; the dispatch worker delivers it (with retries) via the provider configured in Settings → Notifications.',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write')] as const,
      request: { body: { content: { 'application/json': { schema: NotifyBody } } } },
      responses: {
        202: {
          content: { 'application/json': { schema: NotifyQueuedDto } },
          description: 'Queued for delivery',
        },
        400: problemRes,
        401: problemRes,
        403: problemRes,
      },
    }),
    (c) =>
      run(
        c,
        async () => {
          const b = c.req.valid('json');
          const ctx = c.get('orgCtx');
          await sendNotification(ctx, {
            to: b.to,
            subject: b.subject,
            bodyText: b.body,
            bodyHtml: b.html,
            template: b.template,
            vars: b.vars,
          });
          await writeAudit(ctx, {
            action: 'notifications.send',
            targetType: 'notificationDelivery',
            actorType: 'apikey',
            actorId: c.get('apiKey').id,
            metadata: { to: b.to, subject: b.subject, template: b.template ?? null },
          });
          return { queued: true as const, to: b.to };
        },
        202,
      ),
  );
}
