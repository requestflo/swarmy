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
import { sendNotification } from './notifications-send';
import { signPayload } from './webhooks-out.service';

/**
 * Alerting (slice C3) — notification channels, alert rules and the
 * firing/resolved event feed.
 *
 * - Channels: email (delivered via the org notification provider, F6), slack /
 *   teams (incoming-webhook URL) and generic webhook (URL + optional HMAC
 *   secret). Destination config is vault-encrypted in `configEnc` and NEVER
 *   returned to clients — views carry a redacted target only.
 * - Rules: one seeded default per known signal (`ensureDefaultRules`, called
 *   from `listRules`) plus user-defined rules; thresholds/for-duration/channel
 *   bindings are editable, defaults can be disabled but not deleted.
 * - Events: `AlertEvent` rows raised through `alerts-fire.ts` (`fireEvent` /
 *   `resolveEvent`) by the alert-evaluator worker and other slices.
 */

const HTTP_TIMEOUT_MS = 6_000;
/** Signature header on generic webhook deliveries (webhooks-out scheme). */
export const ALERT_SIGNATURE_HEADER = 'X-Swarmy-Signature';

// ── Channel config codec (pure, unit-tested) ──────────────────────────────────

export type ChannelKindDb = 'EMAIL' | 'SLACK' | 'TEAMS' | 'WEBHOOK';

const KIND_TO_DB: Record<ChannelConfigInput['kind'], ChannelKindDb> = {
  email: 'EMAIL',
  slack: 'SLACK',
  teams: 'TEAMS',
  webhook: 'WEBHOOK',
};

const KIND_FROM_DB: Record<ChannelKindDb, ChannelConfigInput['kind']> = {
  EMAIL: 'email',
  SLACK: 'slack',
  TEAMS: 'teams',
  WEBHOOK: 'webhook',
};

/** Parse a decrypted config blob; malformed/mismatched blobs degrade to null. */
export function parseChannelConfig(json: string): ChannelConfigInput | null {
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    if (raw === null || typeof raw !== 'object') return null;
    if (raw.kind === 'email' && typeof raw.to === 'string') {
      return { kind: 'email', to: raw.to };
    }
    if ((raw.kind === 'slack' || raw.kind === 'teams') && typeof raw.url === 'string') {
      return { kind: raw.kind, url: raw.url };
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

/**
 * Redacted destination for the view: an email address, or the URL host — never
 * the full webhook URL (slack/teams incoming-webhook paths are secrets).
 */
export function channelTarget(config: ChannelConfigInput | null): string {
  if (!config) return 'unconfigured';
  if (config.kind === 'email') return config.to;
  try {
    return new URL(config.url).host;
  } catch {
    return 'invalid URL';
  }
}

// ── Notification payload + text rendering (pure, unit-tested) ─────────────────

export interface AlertNotification {
  kind: 'firing' | 'resolved' | 'test';
  signal: string;
  severity: AlertSeverityView;
  resource: string;
  message: string;
  ruleName: string | null;
  /** ISO timestamp of the transition. */
  at: string;
  eventId: string | null;
}

/** One-line text rendering shared by slack/teams/email deliveries. */
export function renderNotificationText(n: AlertNotification): string {
  if (n.kind === 'test') {
    return `swarmy test notification — if you can read this, the channel works. (${n.at})`;
  }
  const head = n.kind === 'firing' ? `🔥 FIRING [${n.severity}]` : `✅ RESOLVED`;
  const rule = n.ruleName ? ` · rule "${n.ruleName}"` : '';
  return `${head} ${n.signal} on ${n.resource} — ${n.message}${rule} (${n.at})`;
}

/** Email subject line for a notification. */
export function renderNotificationSubject(n: AlertNotification): string {
  if (n.kind === 'test') return 'swarmy: test notification';
  const head = n.kind === 'firing' ? `[${n.severity.toUpperCase()}]` : '[RESOLVED]';
  return `swarmy ${head} ${n.signal}: ${n.resource}`;
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

async function postJson(url: string, body: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
  if (config.kind === 'slack' || config.kind === 'teams') {
    return postJson(config.url, JSON.stringify({ text: renderNotificationText(n) }));
  }
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
    hasSecret: config?.kind === 'webhook' && Boolean(config.secret),
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
 * Idempotent default-rule seed: one `isDefault` rule per known signal, created
 * only when that signal has no default yet. Called from `listRules` so every
 * org sees the catalog the first time the page loads.
 */
export async function ensureDefaultRules(ctx: OrgContext): Promise<void> {
  const existing = await ctx.db.alertRule.findMany({
    where: { orgId: ctx.activeOrgId, isDefault: true },
    select: { signal: true },
  });
  const have = new Set(existing.map((r) => r.signal));
  const missing = ALERT_SIGNALS.filter((s) => !have.has(s));
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
    where: { orgId: ctx.activeOrgId },
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
  if (!existing) throw notFound('alert rule', input.id);
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
  if (!existing) throw notFound('alert rule', input.id);
  if (existing.isDefault) {
    throw commandRejected('default rules cannot be deleted — disable them instead');
  }
  await ctx.db.alertRule.delete({ where: { id: existing.id } });
  await writeAudit(ctx, {
    action: 'alerts.deleteRule',
    targetType: 'alertRule',
    targetId: existing.id,
    metadata: { name: existing.name, signal: existing.signal },
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
    ctx.db.alertRule.count({ where: { orgId } }),
    ctx.db.alertRule.count({ where: { orgId, enabled: true } }),
    ctx.db.notificationChannel.count({ where: { orgId } }),
  ]);
  return { firing, firingCritical, resolved24h, rules, rulesEnabled, channels };
}
