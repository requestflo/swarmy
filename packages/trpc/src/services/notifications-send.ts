import type { OrgContext } from '../context';

/**
 * Notification send helper (slice F6) — the one entry point other slices use
 * to send an email-style notification. It resolves the org's template (if one
 * is named), interpolates `{{var}}` placeholders (HTML-escaped in the HTML
 * body), and enqueues a `NotificationDelivery` row. The actual transport
 * happens in the `notification-dispatch` worker (apps/api) — this module is
 * transport-free by design, so it is safe to call from any service or router.
 *
 * Used by alerts (C3) email channels, the notifications `testSend` procedure,
 * and the REST relay `POST /v1/notify` (packages/api-rest routes/notify.ts).
 */

// ── Pure: `{{var}}` interpolation + HTML escaping (unit-tested) ───────────────

/** Minimal HTML entity escape for values interpolated into `bodyHtml`. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Replace `{{name}}` placeholders with values from `vars`. Placeholder names
 * are word-ish (`[A-Za-z0-9_.-]+`); surrounding whitespace inside the braces is
 * tolerated (`{{ name }}`). Unknown placeholders are left verbatim so typos are
 * visible in the delivered mail rather than silently blanked. When `escape` is
 * set each substituted VALUE is HTML-escaped (the template itself is trusted).
 */
export function interpolate(
  template: string,
  vars: Record<string, string> | undefined,
  opts: { escape?: boolean } = {},
): string {
  if (!vars) return template;
  return template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (match, name: string) => {
    const value = vars[name];
    if (value === undefined) return match;
    return opts.escape ? escapeHtml(value) : value;
  });
}

/** A template's renderable parts (subset of the `NotificationTemplate` row). */
export interface RenderableTemplate {
  subject: string;
  bodyText: string | null;
  bodyHtml: string | null;
}

/** Rendered subject + bodies, ready to persist on the delivery row. */
export interface RenderedNotification {
  subject: string;
  bodyText: string | null;
  bodyHtml: string | null;
}

/** Interpolate a template's subject/text/html with `vars` (html values escaped). */
export function renderTemplate(
  tpl: RenderableTemplate,
  vars: Record<string, string> | undefined,
): RenderedNotification {
  return {
    subject: interpolate(tpl.subject, vars),
    bodyText: tpl.bodyText === null ? null : interpolate(tpl.bodyText, vars),
    bodyHtml: tpl.bodyHtml === null ? null : interpolate(tpl.bodyHtml, vars, { escape: true }),
  };
}

// ── The delivery meta bag (bodies ride the row's Json column) ─────────────────

/**
 * What the worker needs to actually send, carried in `NotificationDelivery.meta`
 * (the model has no body columns — the meta Json is the outbox payload).
 */
export interface NotifyDeliveryMeta {
  bodyText: string | null;
  bodyHtml: string | null;
  /** Template name the body was rendered from (null = direct send). */
  template: string | null;
  /** Send attempts made so far (the worker increments this). */
  attempts: number;
  /** ISO time before which the worker must not retry (backoff). */
  nextAttemptAt: string | null;
}

/** Defensive `meta` Json → typed bag (tolerates rows written by older code). */
export function parseNotifyMeta(json: unknown): NotifyDeliveryMeta {
  const o = typeof json === 'object' && json !== null && !Array.isArray(json)
    ? (json as Record<string, unknown>)
    : {};
  return {
    bodyText: typeof o.bodyText === 'string' ? o.bodyText : null,
    bodyHtml: typeof o.bodyHtml === 'string' ? o.bodyHtml : null,
    template: typeof o.template === 'string' ? o.template : null,
    attempts: typeof o.attempts === 'number' && Number.isFinite(o.attempts) ? o.attempts : 0,
    nextAttemptAt: typeof o.nextAttemptAt === 'string' ? o.nextAttemptAt : null,
  };
}

// ── The contract ──────────────────────────────────────────────────────────────

/**
 * Queue a notification for delivery via the org's provider. Resolves `template`
 * (org-scoped, by name) when given — explicit `bodyText`/`bodyHtml` override
 * the template's parts; `vars` interpolate `{{x}}` placeholders (HTML-escaped
 * inside the HTML body). Never throws for "provider not configured": the row
 * is queued and the dispatch worker records the failure on it, so alert
 * pipelines calling this stay resilient.
 */
export async function sendNotification(
  ctx: OrgContext,
  input: {
    to: string;
    subject: string;
    bodyText?: string;
    bodyHtml?: string;
    template?: string;
    vars?: Record<string, string>;
  },
): Promise<void> {
  let subject = input.subject;
  let bodyText = input.bodyText ?? null;
  let bodyHtml = input.bodyHtml ?? null;

  if (input.template) {
    const tpl = await ctx.db.notificationTemplate.findFirst({
      where: { orgId: ctx.activeOrgId, name: input.template },
      select: { subject: true, bodyText: true, bodyHtml: true },
    });
    if (tpl) {
      const rendered = renderTemplate(tpl, input.vars);
      // The named template's subject wins (that's what templates are for);
      // the caller's subject is the fallback for templates without one.
      subject = rendered.subject || input.subject;
      bodyText = input.bodyText ?? rendered.bodyText;
      bodyHtml = input.bodyHtml ?? rendered.bodyHtml;
    }
  }

  // A mail with no body at all still carries its subject as the text body.
  if (bodyText === null && bodyHtml === null) bodyText = subject;

  const meta: NotifyDeliveryMeta = {
    bodyText,
    bodyHtml,
    template: input.template ?? null,
    attempts: 0,
    nextAttemptAt: null,
  };
  await ctx.db.notificationDelivery.create({
    data: {
      orgId: ctx.activeOrgId,
      channel: 'email',
      to: input.to,
      subject,
      status: 'QUEUED',
      meta: meta as unknown as object,
    },
  });
}
