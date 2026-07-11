import { decryptSecret, encryptSecret } from '@swarmy/core/crypto';
import type {
  NotifyConfigView,
  NotifyDeliveriesInput,
  NotifyDeliveriesPage,
  NotifyDeliveryStatusView,
  NotifyDeliveryView,
  NotifyOverview,
  NotifyProviderView,
  NotifyTemplateView,
  NotifyTestSendResult,
  NotifyTestSendInput,
  SaveNotifyTemplateInput,
  SetNotifyConfigInput,
} from '@swarmy/core';
import type { OrgContext } from '../context';
import { commandRejected, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { publicHookUrl } from './inboundWebhooks.service';
import { parseNotifyMeta, sendNotification } from './notifications-send';

/**
 * Notifications (slice F6) — the org's email relay. One `NotificationConfig`
 * per org (provider + vault-encrypted credentials + from-address), reusable
 * `NotificationTemplate`s (`{{var}}` placeholders), and the
 * `NotificationDelivery` outbox drained by the `notification-dispatch` worker
 * in apps/api (the service stays transport-free; nodemailer lives with the
 * worker only).
 *
 * Storage split (docker-native-storage): all three models are swarmy's own
 * concerns — encrypted credentials, user-authored templates, and a durable
 * queue + queryable delivery history — so Postgres is correct; nothing here
 * describes swarm behaviour.
 *
 * Bounce tracking: enabling a provider auto-creates a B4 `InboundEndpoint`
 * (slug `notify-bounces-<org>`) whose targetJson is the internal marker
 * `{kind:'internal', handler:'notifications.bounce'}`. B4's dispatch worker
 * treats that target as malformed and dead-letters the rows — by design our
 * OWN worker polls the endpoint's `InboundDelivery` rows (PENDING or DEAD),
 * maps provider bounce events back to `NotificationDelivery.providerId`, marks
 * them BOUNCED, and stamps the inbound rows DELIVERED. Pragmatic, no shared
 * file edits.
 */

// ── Provider credential codec (the encrypted `configEnc` JSON) ────────────────

/** SMTP creds for the nodemailer transport in the worker. */
export interface SmtpCreds {
  kind: 'smtp';
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  pass: string | null;
}
export interface ResendCreds {
  kind: 'resend';
  apiKey: string;
}
export interface PostmarkCreds {
  kind: 'postmark';
  serverToken: string;
}
export interface MailgunCreds {
  kind: 'mailgun';
  apiKey: string;
  domain: string;
  baseUrl: string;
}
export type NotifyProviderCreds = SmtpCreds | ResendCreds | PostmarkCreds | MailgunCreds;

export const MAILGUN_DEFAULT_BASE = 'https://api.mailgun.net';

/**
 * Decrypted `configEnc` JSON → typed creds; null when the blob is missing or
 * malformed. Pure (takes the already-decrypted JSON) so it is unit-testable
 * and mirrorable by the worker.
 */
export function parseProviderCreds(json: unknown): NotifyProviderCreds | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  const o = json as Record<string, unknown>;
  if (o.kind === 'smtp') {
    if (typeof o.host !== 'string' || !o.host) return null;
    const port = typeof o.port === 'number' && Number.isFinite(o.port) ? o.port : 587;
    return {
      kind: 'smtp',
      host: o.host,
      port,
      secure: o.secure === true,
      user: typeof o.user === 'string' && o.user ? o.user : null,
      pass: typeof o.pass === 'string' && o.pass ? o.pass : null,
    };
  }
  if (o.kind === 'resend') {
    if (typeof o.apiKey !== 'string' || !o.apiKey) return null;
    return { kind: 'resend', apiKey: o.apiKey };
  }
  if (o.kind === 'postmark') {
    if (typeof o.serverToken !== 'string' || !o.serverToken) return null;
    return { kind: 'postmark', serverToken: o.serverToken };
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

/** Non-secret facts for the settings card. NEVER includes key/token/password. */
export function credsSummary(creds: NotifyProviderCreds | null): Record<string, string> {
  if (!creds) return {};
  if (creds.kind === 'smtp') {
    return {
      host: creds.host,
      port: String(creds.port),
      secure: creds.secure ? 'tls' : 'starttls',
      ...(creds.user ? { user: creds.user } : {}),
    };
  }
  if (creds.kind === 'mailgun') {
    return { domain: creds.domain, ...(creds.baseUrl !== MAILGUN_DEFAULT_BASE ? { baseUrl: creds.baseUrl } : {}) };
  }
  return {};
}

// ── Enum codecs (Prisma SCREAMING_CASE ↔ wire lowercase) ──────────────────────

type DbProvider = 'SMTP' | 'RESEND' | 'POSTMARK' | 'MAILGUN';
type DbStatus = 'QUEUED' | 'SENT' | 'FAILED' | 'BOUNCED';

const PROVIDER_TO_DB: Record<NotifyProviderView, DbProvider> = {
  smtp: 'SMTP',
  resend: 'RESEND',
  postmark: 'POSTMARK',
  mailgun: 'MAILGUN',
};

export function providerFromDb(v: string): NotifyProviderView {
  const p = v.toLowerCase();
  return p === 'resend' || p === 'postmark' || p === 'mailgun' ? p : 'smtp';
}

const STATUS_TO_DB: Record<NotifyDeliveryStatusView, DbStatus> = {
  queued: 'QUEUED',
  sent: 'SENT',
  failed: 'FAILED',
  bounced: 'BOUNCED',
};

export function deliveryStatusFromDb(v: string): NotifyDeliveryStatusView {
  const s = v.toLowerCase();
  return s === 'sent' || s === 'failed' || s === 'bounced' ? s : 'queued';
}

// ── Bounce endpoint (auto-created B4 InboundEndpoint) ─────────────────────────

/** Org-unique slug of the auto-created bounce-webhook inbound endpoint. */
export function bounceEndpointSlug(orgId: string): string {
  return `notify-bounces-${orgId}`;
}

/** The internal target marker our dispatch worker recognizes (not B4's kinds). */
export const BOUNCE_TARGET = { kind: 'internal', handler: 'notifications.bounce' } as const;

const CONTROLLER_PUBLIC_URL =
  process.env.CONTROLLER_PUBLIC_URL ?? process.env.BETTER_AUTH_URL ?? 'http://localhost:3021';

/**
 * Idempotently create the bounce-webhook inbound endpoint for the org and
 * return its public URL. Called on every provider save so enabling email
 * always leaves a place for the provider's bounce webhooks to land.
 */
async function ensureBounceEndpoint(ctx: OrgContext): Promise<string> {
  const slug = bounceEndpointSlug(ctx.activeOrgId);
  await ctx.db.inboundEndpoint.upsert({
    where: { orgId_slug: { orgId: ctx.activeOrgId, slug } },
    create: {
      orgId: ctx.activeOrgId,
      name: 'Email bounces (auto-created by notifications)',
      slug,
      verifyKind: 'NONE',
      targetKind: 'FORWARD',
      targetJson: BOUNCE_TARGET as unknown as object,
      retentionDays: 30,
    },
    update: {},
  });
  return publicHookUrl(CONTROLLER_PUBLIC_URL, ctx.activeOrgId, slug);
}

// ── Config: get / set / overview ──────────────────────────────────────────────

interface ConfigRow {
  provider: string;
  configEnc: string | null;
  fromAddress: string | null;
  updatedAt: Date;
}

function decryptCreds(row: ConfigRow): NotifyProviderCreds | null {
  if (!row.configEnc) return null;
  try {
    return parseProviderCreds(JSON.parse(decryptSecret(row.configEnc)));
  } catch {
    return null;
  }
}

async function toConfigView(ctx: OrgContext, row: ConfigRow | null): Promise<NotifyConfigView> {
  if (!row) {
    return {
      provider: 'smtp',
      fromAddress: null,
      configured: false,
      summary: {},
      bounceEndpointUrl: null,
      updatedAt: null,
    };
  }
  const creds = decryptCreds(row);
  const slug = bounceEndpointSlug(ctx.activeOrgId);
  const bounce = await ctx.db.inboundEndpoint.findFirst({
    where: { orgId: ctx.activeOrgId, slug },
    select: { id: true },
  });
  return {
    provider: providerFromDb(row.provider),
    fromAddress: row.fromAddress,
    configured: creds !== null && Boolean(row.fromAddress),
    summary: credsSummary(creds),
    bounceEndpointUrl: bounce ? publicHookUrl(CONTROLLER_PUBLIC_URL, ctx.activeOrgId, slug) : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The org's provider config (credentials never returned — summary only). */
export async function getConfig(ctx: OrgContext): Promise<NotifyConfigView> {
  const row = await ctx.db.notificationConfig.findFirst({
    where: { orgId: ctx.activeOrgId },
  });
  return toConfigView(ctx, row);
}

/** Build the creds JSON for `input`, keeping stored secrets when omitted. */
export function mergeCreds(
  input: SetNotifyConfigInput,
  existing: NotifyProviderCreds | null,
): NotifyProviderCreds {
  const keep = existing && existing.kind === input.provider ? existing : null;
  if (input.provider === 'smtp') {
    const smtp = input.smtp;
    if (!smtp?.host && keep?.kind !== 'smtp') throw commandRejected('SMTP host is required');
    const prev = keep?.kind === 'smtp' ? keep : null;
    return {
      kind: 'smtp',
      host: smtp?.host ?? prev!.host,
      port: smtp?.port ?? prev?.port ?? 587,
      secure: smtp?.secure ?? prev?.secure ?? false,
      user: smtp?.user !== undefined ? smtp.user || null : (prev?.user ?? null),
      pass: smtp?.pass ? smtp.pass : (prev?.pass ?? null),
    };
  }
  if (input.provider === 'resend') {
    const apiKey = input.resend?.apiKey || (keep?.kind === 'resend' ? keep.apiKey : null);
    if (!apiKey) throw commandRejected('Resend API key is required');
    return { kind: 'resend', apiKey };
  }
  if (input.provider === 'postmark') {
    const serverToken =
      input.postmark?.serverToken || (keep?.kind === 'postmark' ? keep.serverToken : null);
    if (!serverToken) throw commandRejected('Postmark server token is required');
    return { kind: 'postmark', serverToken };
  }
  const prev = keep?.kind === 'mailgun' ? keep : null;
  const apiKey = input.mailgun?.apiKey || prev?.apiKey;
  const domain = input.mailgun?.domain || prev?.domain;
  if (!apiKey) throw commandRejected('Mailgun API key is required');
  if (!domain) throw commandRejected('Mailgun sending domain is required');
  return {
    kind: 'mailgun',
    apiKey,
    domain,
    baseUrl: input.mailgun?.baseUrl || prev?.baseUrl || MAILGUN_DEFAULT_BASE,
  };
}

/**
 * Save the provider config (one per org). Credentials are vault-encrypted;
 * omitted secret fields keep their stored values so the form can round-trip
 * without ever seeing them. Also ensures the bounce inbound endpoint exists.
 */
export async function setConfig(
  ctx: OrgContext,
  input: SetNotifyConfigInput,
): Promise<NotifyConfigView> {
  const existing = await ctx.db.notificationConfig.findFirst({
    where: { orgId: ctx.activeOrgId },
  });
  const creds = mergeCreds(input, existing ? decryptCreds(existing) : null);
  const configEnc = encryptSecret(JSON.stringify(creds));

  const row = await ctx.db.notificationConfig.upsert({
    where: { orgId: ctx.activeOrgId },
    create: {
      orgId: ctx.activeOrgId,
      provider: PROVIDER_TO_DB[input.provider],
      configEnc,
      fromAddress: input.fromAddress,
    },
    update: {
      provider: PROVIDER_TO_DB[input.provider],
      configEnc,
      fromAddress: input.fromAddress,
    },
  });
  await ensureBounceEndpoint(ctx);
  await writeAudit(ctx, {
    action: 'notifications.setConfig',
    targetType: 'notificationConfig',
    targetId: row.id,
    metadata: { provider: input.provider, fromAddress: input.fromAddress },
  });
  return toConfigView(ctx, row);
}

/** Hero counts for Settings · Notifications. */
export async function overview(ctx: OrgContext): Promise<NotifyOverview> {
  const orgId = ctx.activeOrgId;
  const since = new Date(Date.now() - 24 * 3_600_000);
  const [config, queued, sent24h, failed24h, bounced24h, templates] = await Promise.all([
    ctx.db.notificationConfig.findFirst({ where: { orgId } }),
    ctx.db.notificationDelivery.count({ where: { orgId, status: 'QUEUED' } }),
    ctx.db.notificationDelivery.count({
      where: { orgId, status: 'SENT', createdAt: { gte: since } },
    }),
    ctx.db.notificationDelivery.count({
      where: { orgId, status: 'FAILED', createdAt: { gte: since } },
    }),
    ctx.db.notificationDelivery.count({
      where: { orgId, status: 'BOUNCED', createdAt: { gte: since } },
    }),
    ctx.db.notificationTemplate.count({ where: { orgId } }),
  ]);
  const configured = Boolean(config?.configEnc && config.fromAddress);
  return {
    configured,
    provider: config ? providerFromDb(config.provider) : null,
    queued,
    sent24h,
    failed24h,
    bounced24h,
    templates,
  };
}

// ── Test send ─────────────────────────────────────────────────────────────────

/** Queue a canned test email to prove the provider config end-to-end. */
export async function testSend(
  ctx: OrgContext,
  input: NotifyTestSendInput,
): Promise<NotifyTestSendResult> {
  const config = await ctx.db.notificationConfig.findFirst({
    where: { orgId: ctx.activeOrgId },
    select: { configEnc: true, fromAddress: true },
  });
  if (!config?.configEnc || !config.fromAddress) {
    throw commandRejected('configure an email provider (and from-address) first');
  }
  await sendNotification(ctx, {
    to: input.to,
    subject: 'swarmy test email',
    bodyText:
      'It works. This test email was queued from Settings → Notifications and delivered by your configured provider.',
    bodyHtml:
      '<p>It works.</p><p>This test email was queued from <strong>Settings → Notifications</strong> and delivered by your configured provider.</p>',
  });
  const row = await ctx.db.notificationDelivery.findFirst({
    where: { orgId: ctx.activeOrgId, to: input.to },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  await writeAudit(ctx, {
    action: 'notifications.testSend',
    targetType: 'notificationDelivery',
    targetId: row?.id,
    metadata: { to: input.to },
  });
  return { queued: true, to: input.to, deliveryId: row?.id ?? '' };
}

// ── Templates CRUD ────────────────────────────────────────────────────────────

interface TemplateRow {
  id: string;
  name: string;
  subject: string;
  bodyText: string | null;
  bodyHtml: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toTemplateView(row: TemplateRow): NotifyTemplateView {
  return {
    id: row.id,
    name: row.name,
    subject: row.subject,
    bodyText: row.bodyText,
    bodyHtml: row.bodyHtml,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listTemplates(ctx: OrgContext): Promise<NotifyTemplateView[]> {
  const rows = await ctx.db.notificationTemplate.findMany({
    where: { orgId: ctx.activeOrgId },
    orderBy: { name: 'asc' },
  });
  return rows.map(toTemplateView);
}

export async function saveTemplate(
  ctx: OrgContext,
  input: SaveNotifyTemplateInput,
): Promise<NotifyTemplateView> {
  const data = {
    name: input.name,
    subject: input.subject,
    bodyText: input.bodyText?.length ? input.bodyText : null,
    bodyHtml: input.bodyHtml?.length ? input.bodyHtml : null,
  };
  const clash = await ctx.db.notificationTemplate.findFirst({
    where: { orgId: ctx.activeOrgId, name: input.name, ...(input.id ? { NOT: { id: input.id } } : {}) },
    select: { id: true },
  });
  if (clash) throw commandRejected(`a template named "${input.name}" already exists`);

  let row: TemplateRow;
  if (input.id) {
    const existing = await ctx.db.notificationTemplate.findFirst({
      where: { id: input.id, orgId: ctx.activeOrgId },
      select: { id: true },
    });
    if (!existing) throw notFound('notification template', input.id);
    row = await ctx.db.notificationTemplate.update({ where: { id: input.id }, data });
  } else {
    row = await ctx.db.notificationTemplate.create({
      data: { orgId: ctx.activeOrgId, ...data },
    });
  }
  await writeAudit(ctx, {
    action: input.id ? 'notifications.updateTemplate' : 'notifications.createTemplate',
    targetType: 'notificationTemplate',
    targetId: row.id,
    metadata: { name: input.name },
  });
  return toTemplateView(row);
}

export async function removeTemplate(
  ctx: OrgContext,
  id: string,
): Promise<{ id: string; removed: true }> {
  const row = await ctx.db.notificationTemplate.findFirst({
    where: { id, orgId: ctx.activeOrgId },
    select: { id: true, name: true },
  });
  if (!row) throw notFound('notification template', id);
  await ctx.db.notificationTemplate.delete({ where: { id: row.id } });
  await writeAudit(ctx, {
    action: 'notifications.removeTemplate',
    targetType: 'notificationTemplate',
    targetId: id,
    metadata: { name: row.name },
  });
  return { id, removed: true };
}

// ── Delivery log ──────────────────────────────────────────────────────────────

interface DeliveryRow {
  id: string;
  to: string;
  subject: string | null;
  status: string;
  providerId: string | null;
  error: string | null;
  meta: unknown;
  createdAt: Date;
}

function toDeliveryView(row: DeliveryRow): NotifyDeliveryView {
  const meta = parseNotifyMeta(row.meta);
  return {
    id: row.id,
    to: row.to,
    subject: row.subject,
    status: deliveryStatusFromDb(row.status),
    providerId: row.providerId,
    error: row.error,
    attempts: meta.attempts,
    template: meta.template,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Delivery log, newest first, optional status filter, cursor-paginated. */
export async function listDeliveries(
  ctx: OrgContext,
  input: NotifyDeliveriesInput,
): Promise<NotifyDeliveriesPage> {
  const rows = await ctx.db.notificationDelivery.findMany({
    where: {
      orgId: ctx.activeOrgId,
      ...(input.status ? { status: STATUS_TO_DB[input.status] } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: input.limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, input.limit);
  return {
    deliveries: page.map(toDeliveryView),
    nextCursor: rows.length > input.limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}
