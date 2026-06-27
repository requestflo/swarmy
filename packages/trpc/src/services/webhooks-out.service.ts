/**
 * Outbound webhooks — event delivery (epic #13 public-api-terraform, Phase 2).
 *
 * Org admins register `WebhookEndpoint`s (a URL + a subscribed set of event
 * types). When a swarmy event fires (e.g. `service.deployed`), `enqueueEvent`
 * fans it out to every active endpoint subscribed to that event type, creating a
 * `WebhookDelivery` row per endpoint. A background worker
 * (`apps/api/src/workers/webhook-dispatch.ts`) drains due deliveries, POSTing the
 * payload with an HMAC-SHA256 signature header and exponential-backoff retry.
 *
 * Secret posture: the per-endpoint signing secret is ENCRYPTED at rest via the
 * shared `@swarmy/core/crypto` vault (like git webhook secrets) — decrypted JIT
 * only to sign an outgoing request, never returned to the client.
 *
 * The `WebhookEndpoint`/`WebhookDelivery` models are delivered as an INTEGRATION
 * snippet; like `terminal.service.ts` we reach the not-yet-generated delegates
 * through a single narrowly-typed `models()` cast.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { encryptSecret } from '@swarmy/core/crypto';
import type { DB } from '@swarmy/db';
import type { OrgContext } from '../context';
import { notFound } from '../errors';
import { writeAudit } from './audit.service';

/** Header carrying the HMAC-SHA256 signature of the raw delivery body. */
export const SIGNATURE_HEADER = 'X-Swarmy-Signature';
/** Header carrying the delivery's event type, for cheap routing on the receiver. */
export const EVENT_HEADER = 'X-Swarmy-Event';
/** Header carrying the unique delivery id (for idempotent receivers). */
export const DELIVERY_HEADER = 'X-Swarmy-Delivery';

/** Wire prefix for endpoint signing secrets — greppable in leak scanners. */
export const WEBHOOK_SECRET_PREFIX = 'whsec';

/** Max delivery attempts before a delivery is marked permanently failed. */
export const MAX_ATTEMPTS = 6;

export type DeliveryStatus = 'pending' | 'delivered' | 'failed';

export interface WebhookEndpointView {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  createdAt: string;
}

/** Returned ONCE at creation — carries the plaintext signing secret. */
export interface WebhookEndpointIssued extends WebhookEndpointView {
  /** Plaintext `whsec_…` — not stored in plaintext, never returned again. */
  secret: string;
}

interface WebhookEndpointRow {
  id: string;
  orgId: string;
  url: string;
  secret: string; // encrypted blob at rest
  events: unknown;
  active: boolean;
  createdAt: Date;
}

interface WebhookDeliveryRow {
  id: string;
  orgId: string;
  endpointId: string;
  eventType: string;
  payload: unknown;
  status: string;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: Date | null;
  createdAt: Date;
  deliveredAt: Date | null;
}

/**
 * The two delegates this feature needs, narrowed to the methods used. A single
 * cast confines the "model not yet generated" gap to one place (mirrors
 * `terminal.service.ts`). After the schema migration lands this is a no-op cast.
 */
interface WebhookDelegates {
  webhookEndpoint: {
    create(args: { data: Record<string, unknown> }): Promise<WebhookEndpointRow>;
    update(args: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<WebhookEndpointRow>;
    delete(args: { where: { id: string } }): Promise<WebhookEndpointRow>;
    findFirst(args: {
      where: Record<string, unknown>;
      select?: Record<string, boolean>;
    }): Promise<WebhookEndpointRow | null>;
    findMany(args: {
      where: Record<string, unknown>;
      orderBy?: Record<string, 'asc' | 'desc'>;
    }): Promise<WebhookEndpointRow[]>;
  };
  webhookDelivery: {
    create(args: { data: Record<string, unknown> }): Promise<WebhookDeliveryRow>;
    update(args: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<WebhookDeliveryRow>;
    findMany(args: {
      where: Record<string, unknown>;
      orderBy?: Record<string, 'asc' | 'desc'>;
      take?: number;
    }): Promise<WebhookDeliveryRow[]>;
  };
}

function models(db: DB): WebhookDelegates {
  return db as unknown as WebhookDelegates;
}

function endpointEvents(row: WebhookEndpointRow): string[] {
  return ((row.events as string[] | null) ?? []) as string[];
}

function toView(row: WebhookEndpointRow): WebhookEndpointView {
  return {
    id: row.id,
    url: row.url,
    events: endpointEvents(row),
    active: row.active,
    createdAt: row.createdAt.toISOString(),
  };
}

// ── HMAC signing ─────────────────────────────────────────────────────────────

/**
 * Sign a raw payload with an endpoint secret. Pure & exported so it is unit-
 * tested in isolation and reusable by receivers. Returns the full header value
 * `sha256=<hex>` (GitHub-compatible scheme).
 */
export function signPayload(secret: string, rawBody: string): string {
  const digest = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  return `sha256=${digest}`;
}

/** Constant-time verification of a presented `sha256=…` signature header. */
export function verifySignature(secret: string, rawBody: string, presented: string): boolean {
  const expected = signPayload(secret, rawBody);
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── backoff schedule ─────────────────────────────────────────────────────────

/**
 * Exponential backoff (pure, exported for unit tests). `attempts` is the number
 * of attempts already made (1 after the first failure). Returns the delay in ms
 * before the next attempt: 30s, 1m, 2m, 4m, 8m … capped at 1h.
 */
export function backoffMs(attempts: number): number {
  const base = 30_000; // 30s
  const cap = 3_600_000; // 1h
  const exp = base * 2 ** Math.max(0, attempts - 1);
  return Math.min(exp, cap);
}

// ── endpoint CRUD ────────────────────────────────────────────────────────────

export async function listEndpoints(ctx: OrgContext): Promise<WebhookEndpointView[]> {
  const rows = await models(ctx.db).webhookEndpoint.findMany({
    where: { orgId: ctx.activeOrgId },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toView);
}

export async function registerEndpoint(
  ctx: OrgContext,
  input: { url: string; events: string[]; secret?: string },
): Promise<WebhookEndpointIssued> {
  const secret = input.secret && input.secret.length ? input.secret : randomSecret();
  const row = await models(ctx.db).webhookEndpoint.create({
    data: {
      orgId: ctx.activeOrgId,
      url: input.url,
      secret: encryptSecret(secret),
      events: input.events,
      active: true,
    },
  });
  await writeAudit(ctx, {
    action: 'webhookEndpoint.register',
    targetType: 'webhookEndpoint',
    targetId: row.id,
    metadata: { url: input.url, events: input.events },
  });
  return { ...toView(row), secret };
}

export async function setEndpointActive(
  ctx: OrgContext,
  id: string,
  active: boolean,
): Promise<WebhookEndpointView> {
  const existing = await models(ctx.db).webhookEndpoint.findFirst({
    where: { id, orgId: ctx.activeOrgId },
    select: { id: true },
  });
  if (!existing) throw notFound('webhook endpoint', id);
  const row = await models(ctx.db).webhookEndpoint.update({ where: { id }, data: { active } });
  await writeAudit(ctx, {
    action: 'webhookEndpoint.update',
    targetType: 'webhookEndpoint',
    targetId: id,
    metadata: { active },
  });
  return toView(row);
}

export async function removeEndpoint(
  ctx: OrgContext,
  id: string,
): Promise<{ id: string; removed: true }> {
  const existing = await models(ctx.db).webhookEndpoint.findFirst({
    where: { id, orgId: ctx.activeOrgId },
    select: { id: true },
  });
  if (!existing) throw notFound('webhook endpoint', id);
  await models(ctx.db).webhookEndpoint.delete({ where: { id } });
  await writeAudit(ctx, {
    action: 'webhookEndpoint.remove',
    targetType: 'webhookEndpoint',
    targetId: id,
  });
  return { id, removed: true };
}

function randomSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}_${randomBytes(24).toString('base64url')}`;
}

// ── event fan-out ────────────────────────────────────────────────────────────

/**
 * Fan an event out to every ACTIVE endpoint in the org that is subscribed to
 * `eventType`, creating one due `WebhookDelivery` per match. Subscription match:
 * the endpoint's `events` list contains `eventType` or the wildcard `*`.
 *
 * Takes a bare `db` (not an OrgContext) so it is callable from any service or
 * worker, including system-actor automation. Returns the ids of the deliveries
 * created (empty when no endpoint matched).
 */
export async function enqueueEvent(
  db: DB,
  orgId: string,
  eventType: string,
  payload: unknown,
): Promise<string[]> {
  const endpoints = await models(db).webhookEndpoint.findMany({ where: { orgId, active: true } });
  const matched = endpoints.filter((e) => {
    const events = endpointEvents(e);
    return events.includes('*') || events.includes(eventType);
  });
  if (!matched.length) return [];

  const now = new Date();
  const ids: string[] = [];
  for (const endpoint of matched) {
    const delivery = await models(db).webhookDelivery.create({
      data: {
        orgId,
        endpointId: endpoint.id,
        eventType,
        payload: payload as object,
        status: 'pending' satisfies DeliveryStatus,
        attempts: 0,
        nextAttemptAt: now,
      },
    });
    ids.push(delivery.id);
  }
  return ids;
}
