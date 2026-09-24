import { decryptSecret, encryptSecret } from '@swarmy/core/crypto';
import type {
  AckAlertEventInput,
  AlertEventView,
  AlertEventsInput,
  AlertRuleRefInput,
  AlertRuleView,
  AlertSeverityView,
  AlertSignal,
  AlertsOverview,
  ChannelConfigInput,
  ChannelRefInput,
  ChannelTestResult,
  CreateAlertRuleInput,
  CreateChannelInput,
  NotificationChannelView,
  UpdateAlertRuleInput,
  UpdateChannelInput,
} from '@swarmy/core';
import { ALERT_SIGNAL_INFO, ALERT_SIGNALS } from '@swarmy/core';
import type { OrgContext } from '../context';
import { commandRejected, notFound } from '../errors';
import { writeAudit } from './audit.service';
import {
  buildChannelRequest,
  channelTarget,
  redactSecrets,
  renderNotificationSubject,
  renderNotificationText,
  type AlertNotification,
} from './alerts-channels';
import { sendNotification } from './notifications-send';
import { signPayload } from './webhooks-out.service';

export {
  channelTarget,
  renderNotificationSubject,
  renderNotificationText,
  type AlertNotification,
} from './alerts-channels';

/**
 * Alerting (slice C3) — notification channels, alert rules and the
 * firing/resolved event feed.
 *
 * - Channels: email (delivered via the org notification provider, F6), slack /
 *   teams / discord (incoming-webhook URL), telegram (bot token + chat id),
 *   ntfy (server + topic + optional token), gotify (server + app token) and
 *   generic webhook (URL + optional HMAC secret). Per-kind payloads are
 *   rendered by the pure `alerts-channels.ts`. Destination config is vault-encrypted in `configEnc` and NEVER
 *   returned to clients — views carry a redacted target only.
 * - Rules: one seeded default per known signal (`ensureDefaultRules`, called
 *   from `listRules` AND every alert-evaluator tick, so every org is covered
 *   without opening the page) plus user-defined rules; thresholds/for-duration/
 *   channel bindings are editable. Deleting a default leaves an opt-out
 *   tombstone (`optedOutAt`, disabled, hidden) so the seed never re-creates it
 *   and the signal stays muted — the autoBackup opt-out pattern.
 * - Events: `AlertEvent` rows raised through `alerts-fire.ts` (`fireEvent` /
 *   `resolveEvent`) by the alert-evaluator worker and other slices.
 */

const HTTP_TIMEOUT_MS = 6_000;
/** Signature header on generic webhook deliveries (webhooks-out scheme). */
export const ALERT_SIGNATURE_HEADER = 'X-Swarmy-Signature';

// ── Channel config codec (pure, unit-tested) ──────────────────────────────────

export type ChannelKindDb =
  | 'EMAIL'
  | 'SLACK'
  | 'TEAMS'
  | 'WEBHOOK'
  | 'DISCORD'
  | 'TELEGRAM'
  | 'NTFY'
  | 'GOTIFY';

const KIND_TO_DB: Record<ChannelConfigInput['kind'], ChannelKindDb> = {
  email: 'EMAIL',
  slack: 'SLACK',
  teams: 'TEAMS',
  webhook: 'WEBHOOK',
  discord: 'DISCORD',
  telegram: 'TELEGRAM',
  ntfy: 'NTFY',
  gotify: 'GOTIFY',
};

const KIND_FROM_DB: Record<ChannelKindDb, ChannelConfigInput['kind']> = {
  EMAIL: 'email',
  SLACK: 'slack',
  TEAMS: 'teams',
  WEBHOOK: 'webhook',
  DISCORD: 'discord',
  TELEGRAM: 'telegram',
  NTFY: 'ntfy',
  GOTIFY: 'gotify',
};

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Parse a decrypted config blob; malformed/mismatched blobs degrade to null. */
export function parseChannelConfig(json: string): ChannelConfigInput | null {
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    if (raw === null || typeof raw !== 'object') return null;
    if (raw.kind === 'email' && typeof raw.to === 'string') {
      return { kind: 'email', to: raw.to };
    }
    if ((raw.kind === 'slack' || raw.kind === 'teams' || raw.kind === 'discord') && typeof raw.url === 'string') {
      return { kind: raw.kind, url: raw.url };
    }
    if (raw.kind === 'telegram' && str(raw.botToken) && str(raw.chatId)) {
      return {
        kind: 'telegram',
        botToken: raw.botToken,
        chatId: raw.chatId,
        ...(typeof raw.threadId === 'number' && raw.threadId > 0 ? { threadId: raw.threadId } : {}),
      };
    }
    if (raw.kind === 'ntfy' && str(raw.topic)) {
      return {
        kind: 'ntfy',
        server: str(raw.server) ? raw.server : 'https://ntfy.sh',
        topic: raw.topic,
        ...(str(raw.token) ? { token: raw.token } : {}),
      };
    }
    if (raw.kind === 'gotify' && str(raw.server) && str(raw.token)) {
      return { kind: 'gotify', server: raw.server, token: raw.token };
    }
    if (raw.kind === 'webhook' && typeof raw.url === 'string') {
      return {
        kind: 'webhook',
        url: raw.url,
        ...(typeof raw.secret === 'string' && raw.secret ? { secret: raw.secret } : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

// ── Channel delivery ───────────────────────────────────────────────────────────

interface ChannelRow {
  id: string;
  orgId: string;
  name: string;
  kind: ChannelKindDb;
  configEnc: string | null;
  enabled: boolean;
  createdAt: Date;
}

function decryptConfig(row: ChannelRow): ChannelConfigInput | null {
  if (!row.configEnc) return null;
  try {
    return parseChannelConfig(decryptSecret(row.configEnc));
  } catch {
    return null;
  }
}

/**
 * POST one rendered channel request. On failure the detail carries the
 * provider's own reason when it gives one (Telegram's `description`, ntfy's
 * `error`, Discord's `message`) — with every secret scrubbed out.
 */
async function sendChannelRequest(req: {
  url: string;
  headers: Record<string, string>;
  body: string;
  secrets: string[];
}): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (res.ok) return { ok: true, detail: `delivered (HTTP ${res.status})` };
    let reason = '';
    try {
      const text = (await res.text()).slice(0, 2000);
      try {
        const j = JSON.parse(text) as Record<string, unknown>;
        const r = j.description ?? j.error ?? j.message;
        reason = typeof r === 'string' ? r : '';
      } catch {
        reason = text.trim().slice(0, 200);
      }
    } catch {
      // body unreadable — status alone
    }
    return {
      ok: false,
      detail: redactSecrets(reason ? `HTTP ${res.status}: ${reason}` : `HTTP ${res.status}`, req.secrets),
    };
  } catch (e) {
    return { ok: false, detail: redactSecrets(e instanceof Error ? e.message : String(e), req.secrets) };
  }
}

/** Deliver one notification to one channel. Best-effort; never throws. */
export async function deliverToChannel(
  ctx: OrgContext,
  row: ChannelRow,
  n: AlertNotification,
): Promise<ChannelTestResult> {
  const config = decryptConfig(row);
  if (!config) return { ok: false, detail: 'channel destination is not configured' };

  if (config.kind === 'email') {
    try {
      await sendNotification(ctx, {
        to: config.to,
        subject: renderNotificationSubject(n),
        bodyText: renderNotificationText(n),
      });
      return { ok: true, detail: `queued email to ${config.to}` };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }
  const push = buildChannelRequest(config, n);
  if (push) return sendChannelRequest(push);
  if (config.kind !== 'webhook') return { ok: false, detail: `unsupported channel kind ${config.kind}` };
  // Generic webhook: the structured event + optional HMAC signature.
  const body = JSON.stringify({ event: n });
  try {
    const res = await fetch(config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.secret ? { [ALERT_SIGNATURE_HEADER]: signPayload(config.secret, body) } : {}),
      },
      body,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    return res.ok
      ? { ok: true, detail: `delivered (HTTP ${res.status})` }
      : { ok: false, detail: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Fan a notification out to a channel set. `channelIds === null` means "the
 * org-default set": every enabled channel (used for ruleless signals).
 */
export async function notifyChannels(
  ctx: OrgContext,
  channelIds: string[] | null,
  n: AlertNotification,
): Promise<void> {
  const rows = await ctx.db.notificationChannel.findMany({
    where: {
      orgId: ctx.activeOrgId,
      enabled: true,
      ...(channelIds ? { id: { in: channelIds } } : {}),
    },
  });
  await Promise.allSettled(rows.map((row) => deliverToChannel(ctx, row as ChannelRow, n)));
}

// ── Channels CRUD ─────────────────────────────────────────────────────────────

function toChannelView(row: ChannelRow): NotificationChannelView {
  const config = decryptConfig(row);
  return {
    id: row.id,
    name: row.name,
    kind: KIND_FROM_DB[row.kind],
    enabled: row.enabled,
    target: channelTarget(config),
    hasSecret:
      (config?.kind === 'webhook' && Boolean(config.secret)) ||
      (config?.kind === 'ntfy' && Boolean(config.token)) ||
      config?.kind === 'telegram' ||
      config?.kind === 'gotify',
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listChannels(ctx: OrgContext): Promise<NotificationChannelView[]> {
  const rows = await ctx.db.notificationChannel.findMany({
    where: { orgId: ctx.activeOrgId },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => toChannelView(r as ChannelRow));
}

export async function createChannel(
  ctx: OrgContext,
  input: CreateChannelInput,
): Promise<NotificationChannelView> {
  const row = await ctx.db.notificationChannel.create({
    data: {
      orgId: ctx.activeOrgId,
      name: input.name,
      kind: KIND_TO_DB[input.config.kind],
      configEnc: encryptSecret(JSON.stringify(input.config)),
      enabled: true,
    },
  });
  await writeAudit(ctx, {
    action: 'alerts.createChannel',
    targetType: 'notificationChannel',
    targetId: row.id,
    metadata: { name: input.name, kind: input.config.kind },
  });
  return toChannelView(row as ChannelRow);
}

export async function updateChannel(
  ctx: OrgContext,
  input: UpdateChannelInput,
): Promise<NotificationChannelView> {
  const existing = await ctx.db.notificationChannel.findFirst({
    where: { id: input.id, orgId: ctx.activeOrgId },
  });
  if (!existing) throw notFound('notification channel', input.id);
  if (input.config && KIND_TO_DB[input.config.kind] !== existing.kind) {
    throw commandRejected('a channel cannot change kind — create a new one instead');
  }
  const row = await ctx.db.notificationChannel.update({
    where: { id: existing.id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.config ? { configEnc: encryptSecret(JSON.stringify(input.config)) } : {}),
    },
  });
  await writeAudit(ctx, {
    action: 'alerts.updateChannel',
    targetType: 'notificationChannel',
    targetId: row.id,
    metadata: {
      name: row.name,
      enabled: row.enabled,
      configChanged: Boolean(input.config),
    },
  });
  return toChannelView(row as ChannelRow);
}

export async function deleteChannel(
  ctx: OrgContext,
  input: ChannelRefInput,
): Promise<{ removed: true }> {
  const existing = await ctx.db.notificationChannel.findFirst({
    where: { id: input.id, orgId: ctx.activeOrgId },
  });
  if (!existing) throw notFound('notification channel', input.id);
  await ctx.db.notificationChannel.delete({ where: { id: existing.id } });
  await writeAudit(ctx, {
    action: 'alerts.deleteChannel',
    targetType: 'notificationChannel',
    targetId: existing.id,
    metadata: { name: existing.name },
  });
  return { removed: true };
}

export async function testChannel(
  ctx: OrgContext,
  input: ChannelRefInput,
): Promise<ChannelTestResult> {
  const existing = await ctx.db.notificationChannel.findFirst({
    where: { id: input.id, orgId: ctx.activeOrgId },
  });
  if (!existing) throw notFound('notification channel', input.id);
  const result = await deliverToChannel(ctx, existing as ChannelRow, {
    kind: 'test',
    signal: 'test',
    severity: 'info',
    resource: 'channel-test',
    message: 'Test notification from swarmy.',
    ruleName: null,
    at: new Date().toISOString(),
    eventId: null,
  });
  await writeAudit(ctx, {
    action: 'alerts.testChannel',
    targetType: 'notificationChannel',
    targetId: existing.id,
    metadata: { ok: result.ok, detail: result.detail },
  });
  return result;
}

// ── Rules CRUD + default seed ─────────────────────────────────────────────────

interface RuleRow {
  id: string;
  name: string;
  signal: string;
  threshold: number | null;
  forSeconds: number;
  channelIds: unknown;
  enabled: boolean;
  isDefault: boolean;
  createdAt: Date;
}

/** Parse the `channelIds` JSON column into a clean string[]. */
export function parseChannelIds(json: unknown): string[] {
  return Array.isArray(json) ? json.filter((x): x is string => typeof x === 'string') : [];
}

function toRuleView(row: RuleRow): AlertRuleView {
  return {
    id: row.id,
    name: row.name,
    signal: row.signal,
    threshold: row.threshold,
    forSeconds: row.forSeconds,
    channelIds: parseChannelIds(row.channelIds),
    enabled: row.enabled,
    isDefault: row.isDefault,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The default signals still to seed: every catalog signal with no `isDefault`
 * row yet. A tombstoned (user-deleted) default counts as present — that is the
 * opt-out: once removed, a default is never re-created. Pure, unit-tested.
 */
export function missingDefaultSignals(existingDefaultSignals: Iterable<string>): AlertSignal[] {
  const have = new Set(existingDefaultSignals);
  return ALERT_SIGNALS.filter((s) => !have.has(s));
}

/**
 * Idempotent default-rule seed: one `isDefault` rule per known signal, created
 * only when that signal has no default yet (tombstones included — see
 * `missingDefaultSignals`). Called from `listRules` and from every
 * alert-evaluator tick, so default alerts are ON for every org from its first
 * connected node — nobody has to open the Alerts page first. A steady state
 * writes nothing.
 */
export async function ensureDefaultRules(ctx: OrgContext): Promise<void> {
  const existing = await ctx.db.alertRule.findMany({
    where: { orgId: ctx.activeOrgId, isDefault: true },
    select: { signal: true },
  });
  const missing = missingDefaultSignals(existing.map((r) => r.signal));
  if (missing.length === 0) return;
  await ctx.db.alertRule.createMany({
    data: missing.map((signal: AlertSignal) => ({
      orgId: ctx.activeOrgId,
      name: ALERT_SIGNAL_INFO[signal].label,
      signal,
      threshold: ALERT_SIGNAL_INFO[signal].defaultThreshold,
      forSeconds: ALERT_SIGNAL_INFO[signal].defaultForSeconds,
      channelIds: [],
      enabled: true,
      isDefault: true,
    })),
  });
}

export async function listRules(ctx: OrgContext): Promise<AlertRuleView[]> {
  await ensureDefaultRules(ctx);
  const rows = await ctx.db.alertRule.findMany({
    // Opt-out tombstones are hidden — they exist only to stop the re-seed.
    where: { orgId: ctx.activeOrgId, optedOutAt: null },
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
  });
  return rows.map((r) => toRuleView(r as RuleRow));
}

export async function createRule(
  ctx: OrgContext,
  input: CreateAlertRuleInput,
): Promise<AlertRuleView> {
  const row = await ctx.db.alertRule.create({
    data: {
      orgId: ctx.activeOrgId,
      name: input.name,
      signal: input.signal,
      threshold: input.threshold ?? null,
      forSeconds: input.forSeconds,
      channelIds: input.channelIds,
      enabled: input.enabled,
      isDefault: false,
    },
  });
  await writeAudit(ctx, {
    action: 'alerts.createRule',
    targetType: 'alertRule',
    targetId: row.id,
    metadata: { name: input.name, signal: input.signal },
  });
  return toRuleView(row as RuleRow);
}

export async function updateRule(
  ctx: OrgContext,
  input: UpdateAlertRuleInput,
): Promise<AlertRuleView> {
  const existing = await ctx.db.alertRule.findFirst({
    where: { id: input.id, orgId: ctx.activeOrgId },
  });
  if (!existing || existing.optedOutAt) throw notFound('alert rule', input.id);
  const row = await ctx.db.alertRule.update({
    where: { id: existing.id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.threshold !== undefined ? { threshold: input.threshold } : {}),
      ...(input.forSeconds !== undefined ? { forSeconds: input.forSeconds } : {}),
      ...(input.channelIds !== undefined ? { channelIds: input.channelIds } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    },
  });
  await writeAudit(ctx, {
    action: 'alerts.updateRule',
    targetType: 'alertRule',
    targetId: row.id,
    metadata: {
      signal: row.signal,
      threshold: row.threshold,
      forSeconds: row.forSeconds,
      enabled: row.enabled,
      channels: parseChannelIds(row.channelIds).length,
    },
  });
  return toRuleView(row as RuleRow);
}

export async function deleteRule(
  ctx: OrgContext,
  input: AlertRuleRefInput,
): Promise<{ removed: true }> {
  const existing = await ctx.db.alertRule.findFirst({
    where: { id: input.id, orgId: ctx.activeOrgId },
  });
  if (!existing || existing.optedOutAt) throw notFound('alert rule', input.id);
  if (existing.isDefault) {
    // Opt-out tombstone: keep the row (disabled + hidden) so the default seed
    // never re-creates it and the signal stays muted for this org.
    await ctx.db.alertRule.update({
      where: { id: existing.id },
      data: { optedOutAt: new Date(), enabled: false },
    });
  } else {
    await ctx.db.alertRule.delete({ where: { id: existing.id } });
  }
  await writeAudit(ctx, {
    action: 'alerts.deleteRule',
    targetType: 'alertRule',
    targetId: existing.id,
    metadata: { name: existing.name, signal: existing.signal, optOut: existing.isDefault },
  });
  return { removed: true };
}

// ── Events ────────────────────────────────────────────────────────────────────

const SEVERITIES: readonly string[] = ['info', 'warning', 'critical'];

function toEventView(row: {
  id: string;
  ruleId: string | null;
  rule: { name: string } | null;
  signal: string;
  severity: string;
  resource: string;
  message: string;
  status: 'FIRING' | 'RESOLVED';
  firedAt: Date;
  resolvedAt: Date | null;
}): AlertEventView {
  return {
    id: row.id,
    ruleId: row.ruleId,
    ruleName: row.rule?.name ?? null,
    signal: row.signal,
    severity: (SEVERITIES.includes(row.severity) ? row.severity : 'warning') as AlertSeverityView,
    resource: row.resource,
    message: row.message,
    status: row.status === 'FIRING' ? 'firing' : 'resolved',
    firedAt: row.firedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  };
}

export async function listEvents(
  ctx: OrgContext,
  input: AlertEventsInput,
): Promise<AlertEventView[]> {
  const rows = await ctx.db.alertEvent.findMany({
    where: {
      orgId: ctx.activeOrgId,
      ...(input.status ? { status: input.status === 'firing' ? 'FIRING' : 'RESOLVED' } : {}),
    },
    include: { rule: { select: { name: true } } },
    orderBy: { firedAt: 'desc' },
    take: input.limit,
  });
  return rows.map(toEventView);
}

/** Acknowledge = manually resolve one firing event (audited; no recovery ping). */
export async function ackEvent(ctx: OrgContext, input: AckAlertEventInput): Promise<AlertEventView> {
  const existing = await ctx.db.alertEvent.findFirst({
    where: { id: input.id, orgId: ctx.activeOrgId },
  });
  if (!existing) throw notFound('alert event', input.id);
  const row = await ctx.db.alertEvent.update({
    where: { id: existing.id },
    data: { status: 'RESOLVED', resolvedAt: existing.resolvedAt ?? new Date() },
    include: { rule: { select: { name: true } } },
  });
  await writeAudit(ctx, {
    action: 'alerts.ack',
    targetType: 'alertEvent',
    targetId: row.id,
    metadata: { signal: row.signal, resource: row.resource },
  });
  return toEventView(row);
}

export async function overview(ctx: OrgContext): Promise<AlertsOverview> {
  const orgId = ctx.activeOrgId;
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [firing, firingCritical, resolved24h, rules, rulesEnabled, channels] = await Promise.all([
    ctx.db.alertEvent.count({ where: { orgId, status: 'FIRING' } }),
    ctx.db.alertEvent.count({ where: { orgId, status: 'FIRING', severity: 'critical' } }),
    ctx.db.alertEvent.count({ where: { orgId, status: 'RESOLVED', resolvedAt: { gte: dayAgo } } }),
    ctx.db.alertRule.count({ where: { orgId, optedOutAt: null } }),
    ctx.db.alertRule.count({ where: { orgId, enabled: true, optedOutAt: null } }),
    ctx.db.notificationChannel.count({ where: { orgId } }),
  ]);
  return { firing, firingCritical, resolved24h, rules, rulesEnabled, channels };
}
