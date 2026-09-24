import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import { badRequest, commandRejected, sendSystemEmail, writeAudit } from '@swarmy/trpc';
import type { RestEnv } from '../middleware';
import { requireScope } from '../middleware';
import { ProblemDto } from '../dto';
import { run } from '../respond';

/**
 * `POST /v1/notify` — send one email through the org's Email service.
 *
 * A convenience for apps holding a write-scoped API key: the message goes out
 * as swarmy (`noreply@<system domain>`) through the Email page's delivery
 * (direct, or the domain's relay). Apps that send their own mail use an email
 * credential and `/email/v1/send` instead.
 */

const NotifyBody = z
  .object({
    to: z.string().trim().email().max(254).openapi({ example: 'ops@example.com' }),
    subject: z.string().trim().min(1).max(200).openapi({ example: 'Deploy finished' }),
    /** Plain-text body. Optional when `template` is set. */
    body: z.string().max(20_000).optional(),
    /** Optional HTML body (sent alongside `body` as the text part). */
    html: z.string().max(50_000).optional(),
    /** Name of a saved email template (Email → Templates) to render. */
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
      summary: 'Send an email through the org’s Email service',
      description:
        'Hands the message to the org’s Email service (direct delivery or the domain’s relay, as set on the Email page). Needs Email turned on with a verified domain.',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write')] as const,
      request: { body: { content: { 'application/json': { schema: NotifyBody } } } },
      responses: {
        202: {
          content: { 'application/json': { schema: NotifyQueuedDto } },
          description: 'Accepted for delivery',
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
          if (!b.body && !b.html && !b.template) {
            throw badRequest('give body, html or template');
          }
          const r = await sendSystemEmail(ctx.db, {
            orgId: ctx.activeOrgId,
            to: b.to,
            subject: b.subject,
            text: b.body,
            html: b.html,
            ...(b.template ? { template: b.template, variables: b.vars ?? {} } : {}),
          });
          if (!r.sent) {
            throw commandRejected(`email not sent: ${r.reason ?? 'unknown'} (turn on Email and verify a sending domain)`);
          }
          await writeAudit(ctx, {
            action: 'notifications.send',
            targetType: 'email',
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
