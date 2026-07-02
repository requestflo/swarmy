/**
 * Notification dispatch worker (slice F6 notifications).
 *
 * Every tick, drain due QUEUED `NotificationDelivery` rows (batch of 20) and
 * send each via its org's configured provider:
 *   - resend   → POST https://api.resend.com/emails            (bearer key)
 *   - postmark → POST https://api.postmarkapp.com/email        (server token)
 *   - mailgun  → POST <base>/v3/<domain>/messages              (form, basic auth)
 *   - smtp     → nodemailer transport (host/port/secure/user/pass)
 * Outcome: success → SENT (+providerId, the provider's message id); failure →
 * retry with backoff (1m, 5m, 15m) up to 4 total attempts, then FAILED final.
 * Retry state (attempts/nextAttemptAt) and the rendered bodies ride the row's
 * `meta` Json (the model has no body columns) — the shape mirrors the
 * unit-tested `parseNotifyMeta` in `@swarmy/trpc` notifications-send.ts.
 *
 * Bounce tracking: enabling a provider auto-creates a B4 InboundEndpoint
 * (slug `notify-bounces-<org>`) with the internal target marker
 * `{kind:'internal', handler:'notifications.bounce'}`. B4's dispatch worker
 * treats that target as malformed and dead-letters those rows — by design.
 * THIS worker owns them instead: it polls the endpoint's InboundDelivery rows
 * (PENDING or DEAD), maps provider bounce payloads back to
 * `NotificationDelivery.providerId`, marks the matching deliveries BOUNCED,
 * and stamps the inbound rows DELIVERED so neither worker touches them again.
 * (Worst case race: B4 dead-letters a row between our ticks — we pick DEAD
 * rows up on the next tick; marking bounced is idempotent.)
 *
 * nodemailer is an apps/api-only dep (the trpc service stays transport-free).
 * The provider payload builders + backoff + bounce parser below are pure and
 * unit-tested in `notification-dispatch.test.ts`.
 */
import nodemailer from 'nodemailer';
import { prisma } from '@swarmy/db';
import { decryptSecret } from '@swarmy/core/crypto';

const TICK_MS = 10_000;
/** Max deliveries sent per tick (fairness / backpressure). */
const BATCH = 20;
/** Per-request timeout so a hanging provider can't stall the worker. */
const REQUEST_TIMEOUT_MS = 15_000;

// ── Pure: retry schedule ──────────────────────────────────────────────────────

/** Backoff after each failed attempt: 1m, 5m, 15m — then FAILED final. */
export const NOTIFY_BACKOFF_MS = [60_000, 300_000, 900_000] as const;
/** 1 initial attempt + one retry per backoff step. */
export const NOTIFY_MAX_ATTEMPTS = NOTIFY_BACKOFF_MS.length + 1;

/** Delay before the NEXT attempt given attempts already made (1 = first failure). */
export function notifyBackoffMs(attempts: number): number {
  const i = Math.max(0, Math.min(attempts - 1, NOTIFY_BACKOFF_MS.length - 1));
  return NOTIFY_BACKOFF_MS[i]!;
}

// ── Pure: provider creds + delivery meta (mirrors notifications.service.ts) ──

interface SmtpCreds {
  kind: 'smtp';
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  pass: string | null;
}
interface ResendCreds {
  kind: 'resend';
  apiKey: string;
}
interface PostmarkCreds {
  kind: 'postmark';
  serverToken: string;
}
interface MailgunCreds {
  kind: 'mailgun';
  apiKey: string;
  domain: string;
  baseUrl: string;
}
export type ProviderCreds = SmtpCreds | ResendCreds | PostmarkCreds | MailgunCreds;

const MAILGUN_DEFAULT_BASE = 'https://api.mailgun.net';

/** Decrypted configEnc JSON → typed creds (mirror of `parseProviderCreds`). */
export function parseProviderCreds(json: unknown): ProviderCreds | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  const o = json as Record<string, unknown>;
  if (o.kind === 'smtp') {
    if (typeof o.host !== 'string' || !o.host) return null;
    return {
      kind: 'smtp',
      host: o.host,
      port: typeof o.port === 'number' && Number.isFinite(o.port) ? o.port : 587,
      secure: o.secure === true,
      user: typeof o.user === 'string' && o.user ? o.user : null,
      pass: typeof o.pass === 'string' && o.pass ? o.pass : null,
    };
  }
  if (o.kind === 'resend') {
    return typeof o.apiKey === 'string' && o.apiKey ? { kind: 'resend', apiKey: o.apiKey } : null;
  }
  if (o.kind === 'postmark') {
    return typeof o.serverToken === 'string' && o.serverToken
      ? { kind: 'postmark', serverToken: o.serverToken }
      : null;
  }
  if (o.kind === 'mailgun') {
    if (typeof o.apiKey !== 'string' || !o.apiKey) return null;
    if (typeof o.domain !== 'string' || !o.domain) return null;
    return {
      kind: 'mailgun',
      apiKey: o.apiKey,
      domain: o.domain,
      baseUrl: typeof o.baseUrl === 'string' && o.baseUrl ? o.baseUrl : MAILGUN_DEFAULT_BASE,
    };
  }
  return null;
}

interface DeliveryMeta {
  bodyText: string | null;
  bodyHtml: string | null;
  template: string | null;
  attempts: number;
  nextAttemptAt: string | null;
}

/** Mirror of `parseNotifyMeta` (@swarmy/trpc notifications-send.ts). */
export function parseMeta(json: unknown): DeliveryMeta {
  const o =
    typeof json === 'object' && json !== null && !Array.isArray(json)
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

// ── Pure: HTTP provider payload builders (unit-tested) ────────────────────────

export interface MailInput {
  from: string;
  to: string;
  subject: string;
  text: string | null;
  html: string | null;
}

export interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** POST https://api.resend.com/emails — bearer key, JSON body. */
export function buildResendRequest(apiKey: string, mail: MailInput): ProviderRequest {
  return {
    url: 'https://api.resend.com/emails',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: mail.from,
      to: [mail.to],
      subject: mail.subject,
      ...(mail.text !== null ? { text: mail.text } : {}),
      ...(mail.html !== null ? { html: mail.html } : {}),
    }),
  };
}

/** POST https://api.postmarkapp.com/email — server token header, JSON body. */
export function buildPostmarkRequest(serverToken: string, mail: MailInput): ProviderRequest {
  return {
    url: 'https://api.postmarkapp.com/email',
    headers: {
      'x-postmark-server-token': serverToken,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      From: mail.from,
      To: mail.to,
      Subject: mail.subject,
      ...(mail.text !== null ? { TextBody: mail.text } : {}),
      ...(mail.html !== null ? { HtmlBody: mail.html } : {}),
    }),
  };
}

/** POST <base>/v3/<domain>/messages — basic auth `api:<key>`, form body. */
export function buildMailgunRequest(creds: MailgunCreds, mail: MailInput): ProviderRequest {
  const form = new URLSearchParams();
  form.set('from', mail.from);
  form.set('to', mail.to);
  form.set('subject', mail.subject);
  if (mail.text !== null) form.set('text', mail.text);
  if (mail.html !== null) form.set('html', mail.html);
  return {
    url: `${creds.baseUrl.replace(/\/+$/, '')}/v3/${creds.domain}/messages`,
    headers: {
      authorization: `Basic ${Buffer.from(`api:${creds.apiKey}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  };
}

/** Pull the provider's message id out of a (parsed) success response. */
export function extractProviderId(kind: 'resend' | 'postmark' | 'mailgun', json: unknown): string | null {
  if (typeof json !== 'object' || json === null) return null;
  const o = json as Record<string, unknown>;
  const raw = kind === 'postmark' ? o.MessageID : o.id;
  if (typeof raw !== 'string' || !raw) return null;
  // Mailgun wraps ids in angle brackets (`<2024…@mg.example>`); store bare.
  return raw.replace(/^</, '').replace(/>$/, '');
}

// ── Pure: bounce webhook parsing (unit-tested) ────────────────────────────────

export interface BounceEvent {
  /** The provider message id the bounce refers to (bare, no angle brackets). */
  providerId: string;
  reason: string | null;
}

function bareId(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  return raw.replace(/^</, '').replace(/>$/, '');
}

/**
 * Parse a provider bounce/complaint webhook body into the provider message id
 * it refers to. Understands Resend (`type: "email.bounced"`), Postmark
 * (`RecordType: "Bounce"`), Mailgun (`event-data.event: "failed"`), and a
 * generic `{event:'bounce', providerId|messageId}` shape. Returns null for
 * non-bounce events (delivered/open/click) and unrecognized payloads.
 */
export function parseBounce(bodyText: string): BounceEvent | null {
  let json: unknown;
  try {
    json = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null) return null;
  const o = json as Record<string, unknown>;

  // Resend: { type: 'email.bounced'|'email.complained', data: { email_id } }
  if (typeof o.type === 'string' && /bounce|complain/i.test(o.type)) {
    const data = (o.data ?? {}) as Record<string, unknown>;
    const id = bareId(data.email_id ?? data.id);
    if (id) {
      const bounce = (data.bounce ?? {}) as Record<string, unknown>;
      const reason = typeof bounce.message === 'string' ? bounce.message : null;
      return { providerId: id, reason };
    }
  }

  // Postmark: { RecordType: 'Bounce'|'SpamComplaint', MessageID, Description }
  if (typeof o.RecordType === 'string' && /bounce|spamcomplaint/i.test(o.RecordType)) {
    const id = bareId(o.MessageID);
    if (id) {
      return { providerId: id, reason: typeof o.Description === 'string' ? o.Description : null };
    }
  }

  // Mailgun: { 'event-data': { event: 'failed', severity, reason,
  //            message: { headers: { 'message-id' } }, 'delivery-status': { description } } }
  const eventData = o['event-data'];
  if (typeof eventData === 'object' && eventData !== null) {
    const ed = eventData as Record<string, unknown>;
    if (ed.event === 'failed' || ed.event === 'complained') {
      const message = (ed.message ?? {}) as Record<string, unknown>;
      const headers = (message.headers ?? {}) as Record<string, unknown>;
      const id = bareId(headers['message-id']);
      if (id) {
        const ds = (ed['delivery-status'] ?? {}) as Record<string, unknown>;
        const reason =
          typeof ds.description === 'string' && ds.description
            ? ds.description
            : typeof ed.reason === 'string'
              ? ed.reason
              : null;
        return { providerId: id, reason };
      }
    }
  }

  // Generic escape hatch: { event: 'bounce'|'bounced', providerId|messageId, reason? }
  if (typeof o.event === 'string' && /^bounced?$/i.test(o.event)) {
    const id = bareId(o.providerId ?? o.messageId);
    if (id) return { providerId: id, reason: typeof o.reason === 'string' ? o.reason : null };
  }

  return null;
}

/** True when an InboundEndpoint targetJson is our internal bounce marker. */
export function isBounceTarget(json: unknown): boolean {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return false;
  const o = json as Record<string, unknown>;
  return o.kind === 'internal' && o.handler === 'notifications.bounce';
}

// ── Send paths ────────────────────────────────────────────────────────────────

interface DeliveryRow {
  id: string;
  orgId: string;
  to: string;
  subject: string | null;
  meta: unknown;
}

interface OrgSendConfig {
  creds: ProviderCreds;
  from: string;
}

/** null → "provider not configured / creds unreadable". */
async function loadOrgConfig(orgId: string): Promise<OrgSendConfig | null> {
  const row = await prisma.notificationConfig.findFirst({
    where: { orgId },
    select: { configEnc: true, fromAddress: true },
  });
  if (!row?.configEnc || !row.fromAddress) return null;
  try {
    const creds = parseProviderCreds(JSON.parse(decryptSecret(row.configEnc)));
    return creds ? { creds, from: row.fromAddress } : null;
  } catch {
    return null;
  }
}

async function sendHttp(
  kind: 'resend' | 'postmark' | 'mailgun',
  req: ProviderRequest,
): Promise<{ providerId: string | null } | { error: string }> {
  try {
    const res = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      return { error: `HTTP ${res.status}${detail ? `: ${detail}` : ''}` };
    }
    const json = (await res.json().catch(() => null)) as unknown;
    return { providerId: extractProviderId(kind, json) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

async function sendSmtp(
  creds: SmtpCreds,
  mail: MailInput,
): Promise<{ providerId: string | null } | { error: string }> {
  try {
    const transport = nodemailer.createTransport({
      host: creds.host,
      port: creds.port,
      secure: creds.secure,
      ...(creds.user && creds.pass ? { auth: { user: creds.user, pass: creds.pass } } : {}),
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: REQUEST_TIMEOUT_MS,
    });
    try {
      const info = await transport.sendMail({
        from: mail.from,
        to: mail.to,
        subject: mail.subject,
        ...(mail.text !== null ? { text: mail.text } : {}),
        ...(mail.html !== null ? { html: mail.html } : {}),
      });
      const id = typeof info.messageId === 'string' ? info.messageId : null;
      return { providerId: id ? id.replace(/^</, '').replace(/>$/, '') : null };
    } finally {
      transport.close();
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

async function sendVia(
  config: OrgSendConfig,
  mail: MailInput,
): Promise<{ providerId: string | null } | { error: string }> {
  const { creds } = config;
  if (creds.kind === 'smtp') return sendSmtp(creds, mail);
  if (creds.kind === 'resend') return sendHttp('resend', buildResendRequest(creds.apiKey, mail));
  if (creds.kind === 'postmark') {
    return sendHttp('postmark', buildPostmarkRequest(creds.serverToken, mail));
  }
  return sendHttp('mailgun', buildMailgunRequest(creds, mail));
}

async function markSent(row: DeliveryRow, meta: DeliveryMeta, providerId: string | null): Promise<void> {
  await prisma.notificationDelivery.update({
    where: { id: row.id },
    data: {
      status: 'SENT',
      providerId,
      error: null,
      meta: { ...meta, attempts: meta.attempts + 1, nextAttemptAt: null } as unknown as object,
    },
  });
}

async function markFailedOrRetry(row: DeliveryRow, meta: DeliveryMeta, error: string): Promise<void> {
  const attempts = meta.attempts + 1;
  const final = attempts >= NOTIFY_MAX_ATTEMPTS;
  await prisma.notificationDelivery.update({
    where: { id: row.id },
    data: {
      status: final ? 'FAILED' : 'QUEUED',
      error: error.slice(0, 2_000),
      meta: {
        ...meta,
        attempts,
        nextAttemptAt: final ? null : new Date(Date.now() + notifyBackoffMs(attempts)).toISOString(),
      } as unknown as object,
    },
  });
}

async function deliverOne(row: DeliveryRow, config: OrgSendConfig | null): Promise<void> {
  const meta = parseMeta(row.meta);
  if (!config) {
    await markFailedOrRetry(row, meta, 'email provider not configured');
    return;
  }
  const mail: MailInput = {
    from: config.from,
    to: row.to,
    subject: row.subject ?? '(no subject)',
    text: meta.bodyText,
    html: meta.bodyHtml,
  };
  const result = await sendVia(config, mail);
  if ('error' in result) await markFailedOrRetry(row, meta, result.error);
  else await markSent(row, meta, result.providerId);
}

/** Drain due QUEUED rows (respecting per-row backoff carried in meta). */
async function drainQueued(): Promise<void> {
  // Over-fetch, then filter by the meta backoff stamp (Json → no SQL filter).
  const rows = (await prisma.notificationDelivery.findMany({
    where: { status: 'QUEUED' },
    orderBy: { createdAt: 'asc' },
    take: BATCH * 3,
    select: { id: true, orgId: true, to: true, subject: true, meta: true },
  })) as DeliveryRow[];
  const now = Date.now();
  const due = rows
    .filter((r) => {
      const next = parseMeta(r.meta).nextAttemptAt;
      return next === null || Date.parse(next) <= now;
    })
    .slice(0, BATCH);
  if (!due.length) return;

  const configs = new Map<string, OrgSendConfig | null>();
  for (const row of due) {
    if (!configs.has(row.orgId)) configs.set(row.orgId, await loadOrgConfig(row.orgId));
    await deliverOne(row, configs.get(row.orgId) ?? null).catch(() => undefined);
  }
}

// ── Bounce processing (rows landing on our internal-target endpoints) ─────────

async function processBounces(): Promise<void> {
  const endpoints = await prisma.inboundEndpoint.findMany({
    where: { slug: { startsWith: 'notify-bounces-' } },
    select: { id: true, orgId: true, targetJson: true },
  });
  for (const ep of endpoints) {
    if (!isBounceTarget(ep.targetJson)) continue;
    const rows = await prisma.inboundDelivery.findMany({
      // PENDING = fresh; DEAD = B4's worker dead-lettered the internal target
      // before we got to it (expected race — see the module doc).
      where: { endpointId: ep.id, status: { in: ['PENDING', 'DEAD'] } },
      orderBy: { receivedAt: 'asc' },
      take: 50,
      select: { id: true, bodyText: true },
    });
    for (const row of rows) {
      const bounce = parseBounce(row.bodyText);
      if (bounce) {
        await prisma.notificationDelivery
          .updateMany({
            where: { orgId: ep.orgId, providerId: bounce.providerId },
            data: { status: 'BOUNCED', error: bounce.reason ?? 'bounced' },
          })
          .catch(() => undefined);
      }
      // Processed (bounce or not) → DELIVERED so neither worker revisits it.
      await prisma.inboundDelivery
        .update({
          where: { id: row.id },
          data: { status: 'DELIVERED', lastError: null, nextAttemptAt: null },
        })
        .catch(() => undefined);
    }
  }
}

export function startNotificationDispatch(): () => void {
  const timer = setInterval(() => {
    drainQueued().catch(() => undefined);
    processBounces().catch(() => undefined);
  }, TICK_MS);
  return () => clearInterval(timer);
}
