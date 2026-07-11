import { createHmac, timingSafeEqual } from 'node:crypto';
import { encryptSecret } from '@swarmy/core/crypto';
import type {
  CreateInboundEndpointInput,
  InboundDeliveriesInput,
  InboundDeliveriesPage,
  InboundDeliveryDetailView,
  InboundDeliveryStatusView,
  InboundDeliveryView,
  InboundEndpointView,
  InboundTarget,
  InboundTargetKindView,
  InboundVerifyKindView,
  InboundWebhooksOverview,
  UpdateInboundEndpointInput,
} from '@swarmy/core';
import type { OrgContext } from '../context';
import { commandRejected, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { assertControllerDomainAvailable } from './ingress.service';

/**
 * Inbound webhook gateway (slice B4) — public endpoints, verified deliveries,
 * retry/replay/DLQ.
 *
 * Third parties (Stripe, GitHub, custom HMAC) POST to the public receiver
 * `POST /hooks/i/<org>/<slug>` (apps/api/src/inbound-hooks.ts), which verifies
 * the payload per `verifyKind` and persists an `InboundDelivery`. The
 * `inbound-webhook-dispatch` worker then delivers pending rows to the
 * endpoint's target — a queue on a managed cache cluster (B1 conventions) or a
 * controller-reachable forward URL — with backoff (1m, 5m, 15m, 1h, 6h) and a
 * DEAD letter status after the retry budget is spent.
 *
 * Storage split (docker-native-storage): `InboundEndpoint` is the user's INPUT
 * artifact and `InboundDelivery` is a durable delivery outbox + queryable
 * history — both legitimately Postgres (same category as the outbound
 * `WebhookDelivery` outbox). Verify secrets are vault-encrypted at rest and
 * never returned to clients.
 *
 * The receiver and the dispatch worker mirror the pure helpers below (neither
 * can subpath-import an internal @swarmy/trpc module — same constraint the
 * queue/cache reconcile workers document). This file holds the unit-tested
 * canonical copies.
 */

// ── Constants (kept in sync with the receiver + dispatch worker mirrors) ──────

/** Max raw body persisted per delivery — the receiver responds 413 above this. */
export const INBOUND_BODY_MAX_BYTES = 256 * 1024;

/** Stripe timestamp tolerance — reject signatures older/newer than this. */
export const STRIPE_TOLERANCE_SECONDS = 300;

/** Signature headers, per verify kind. */
export const INBOUND_HMAC_HEADER = 'x-signature';
export const INBOUND_GITHUB_HEADER = 'x-hub-signature-256';
export const INBOUND_STRIPE_HEADER = 'stripe-signature';

/**
 * Retry backoff after each failed attempt: the first attempt fires as soon as
 * the worker picks the row up, then 5 retries at 1m, 5m, 15m, 1h, 6h — after
 * which the delivery is DEAD (6 attempts total).
 */
export const INBOUND_BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000, 21_600_000] as const;
export const INBOUND_MAX_ATTEMPTS = INBOUND_BACKOFF_MS.length + 1;

// ── Pure: signature verification (unit-tested canonical copies) ───────────────

/** Constant-time string compare that never short-circuits on content. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** `sha256=<hex hmac of raw body>` — the generic-HMAC and GitHub scheme. */
export function hmacSignature(secret: string, rawBody: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
}

/** Generic HMAC (`X-Signature: sha256=…`) — constant-time verify. */
export function verifyHmac(secret: string, rawBody: string, header: string | null | undefined): boolean {
  if (!secret || !header) return false;
  return safeEqual(header.trim(), hmacSignature(secret, rawBody));
}

/** GitHub (`X-Hub-Signature-256: sha256=…`) — same scheme as generic HMAC. */
export function verifyGithub(secret: string, rawBody: string, header: string | null | undefined): boolean {
  return verifyHmac(secret, rawBody, header);
}

/** Parse a `Stripe-Signature` header: `t=<unix>,v1=<hex>[,v1=<hex>…]`. */
export function parseStripeHeader(header: string): { t: number; v1: string[] } | null {
  const parts = header.split(',').map((p) => p.trim());
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === 't') {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n)) t = n;
    } else if (key === 'v1' && value) {
      v1.push(value);
    }
  }
  if (t === null || v1.length === 0) return null;
  return { t, v1 };
}

/**
 * Stripe scheme: HMAC-SHA256 of `<t>.<rawBody>` must match one of the `v1`
 * signatures, and `t` must be within `toleranceSeconds` of now (replay guard).
 */
export function verifyStripe(
  secret: string,
  rawBody: string,
  header: string | null | undefined,
  opts: { nowSeconds?: number; toleranceSeconds?: number } = {},
): boolean {
  if (!secret || !header) return false;
  const parsed = parseStripeHeader(header);
  if (!parsed) return false;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = opts.toleranceSeconds ?? STRIPE_TOLERANCE_SECONDS;
  if (Math.abs(now - parsed.t) > tolerance) return false;
  const expected = createHmac('sha256', secret)
    .update(`${parsed.t}.${rawBody}`, 'utf8')
    .digest('hex');
  return parsed.v1.some((sig) => safeEqual(sig, expected));
}

/**
 * Verify a raw inbound body per the endpoint's verify kind. `headers` is a
 * LOWERCASE-keyed record of the request headers. `none` always passes; the
 * verifying kinds fail closed when the secret or header is missing.
 */
export function verifyInbound(
  kind: InboundVerifyKindView,
  secret: string | null,
  rawBody: string,
  headers: Record<string, string>,
  opts: { nowSeconds?: number } = {},
): boolean {
  if (kind === 'none') return true;
  if (!secret) return false;
  if (kind === 'hmac') return verifyHmac(secret, rawBody, headers[INBOUND_HMAC_HEADER]);
  if (kind === 'github') return verifyGithub(secret, rawBody, headers[INBOUND_GITHUB_HEADER]);
  return verifyStripe(secret, rawBody, headers[INBOUND_STRIPE_HEADER], opts);
}

// ── Pure: backoff + target codec (unit-tested canonical copies) ───────────────

/**
 * Delay before the NEXT attempt, given the number of attempts already made
 * (1 after the first failure). Beyond the schedule the delivery goes DEAD —
 * callers should check {@link isDeadAfter} first.
 */
export function inboundBackoffMs(attempts: number): number {
  const i = Math.max(0, Math.min(attempts - 1, INBOUND_BACKOFF_MS.length - 1));
  return INBOUND_BACKOFF_MS[i]!;
}

/** True when a delivery that has made `attempts` attempts must go DEAD. */
export function isDeadAfter(attempts: number): boolean {
  return attempts >= INBOUND_MAX_ATTEMPTS;
}

/** `targetJson` → validated InboundTarget; null when malformed. */
export function parseInboundTarget(json: unknown): InboundTarget | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  const o = json as Record<string, unknown>;
  if (o.kind === 'queue') {
    if (typeof o.cacheCluster !== 'string' || !o.cacheCluster) return null;
    if (typeof o.queue !== 'string' || !o.queue) return null;
    return {
      kind: 'queue',
      cacheCluster: o.cacheCluster,
      queue: o.queue,
      convention: o.convention === 'bullmq' ? 'bullmq' : 'list',
    };
  }
  if (o.kind === 'forward') {
    if (typeof o.url !== 'string' || !/^https?:\/\//.test(o.url)) return null;
    return { kind: 'forward', url: o.url };
  }
  return null;
}

/** The public receiver URL for an endpoint. */
export function publicHookUrl(baseUrl: string, orgId: string, slug: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/hooks/i/${orgId}/${slug}`;
}

// ── Enum codecs (Prisma SCREAMING_CASE ↔ wire lowercase) ──────────────────────

type DbVerifyKind = 'NONE' | 'HMAC' | 'GITHUB' | 'STRIPE';
type DbTargetKind = 'QUEUE' | 'FORWARD';
type DbDeliveryStatus = 'PENDING' | 'DELIVERED' | 'FAILED' | 'DEAD';

const VERIFY_TO_DB: Record<InboundVerifyKindView, DbVerifyKind> = {
  none: 'NONE',
  hmac: 'HMAC',
  github: 'GITHUB',
  stripe: 'STRIPE',
};

export function verifyKindFromDb(v: string): InboundVerifyKindView {
  const k = v.toLowerCase();
  return k === 'hmac' || k === 'github' || k === 'stripe' ? k : 'none';
}

export function deliveryStatusFromDb(v: string): InboundDeliveryStatusView {
  const s = v.toLowerCase();
  return s === 'delivered' || s === 'failed' || s === 'dead' ? s : 'pending';
}

// ── Row shapes + view projection ──────────────────────────────────────────────

const CONTROLLER_PUBLIC_URL =
  process.env.CONTROLLER_PUBLIC_URL ?? process.env.BETTER_AUTH_URL ?? 'http://localhost:3021';

interface EndpointRow {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  stackName: string | null;
  domain: string | null;
  verifyKind: string;
  verifySecretEnc: string | null;
  targetKind: string;
  targetJson: unknown;
  transformTemplate: string | null;
  responseTemplate: string | null;
  retentionDays: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Extra create/update fields riding next to the core inputs. */
export interface EndpointTemplateFields {
  stackName?: string;
  domain?: string;
  transformTemplate?: string;
  responseTemplate?: string;
}

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** '' clears; otherwise a bare lowercase hostname (unit of the CNAME hint). */
export function normalizeEndpointDomain(input: string | undefined): string | null | undefined {
  if (input === undefined) return undefined;
  const domain = input.trim().toLowerCase().replace(/\.$/, '');
  if (domain === '') return null;
  if (domain.length > 253 || !DOMAIN_RE.test(domain)) {
    throw commandRejected(`"${input}" is not a valid hostname — try hooks.example.com`);
  }
  return domain;
}

/** '' clears a stored template; whitespace-only counts as empty. */
export function normalizeTemplate(input: string | undefined): string | null | undefined {
  if (input === undefined) return undefined;
  return input.trim() === '' ? null : input;
}

interface DeliveryRow {
  id: string;
  orgId: string;
  endpointId: string;
  receivedAt: Date;
  headersJson: unknown;
  bodyText: string;
  verifyOk: boolean;
  status: string;
  attempts: number;
  nextAttemptAt: Date | null;
  lastError: string | null;
}

function toEndpointView(
  row: EndpointRow,
  stats: { deliveries24h: number; lastDeliveryAt: Date | null },
): InboundEndpointView {
  const target = parseInboundTarget(row.targetJson) ?? {
    kind: 'forward' as const,
    url: 'https://example.invalid',
  };
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    stackName: row.stackName,
    domain: row.domain,
    url: publicHookUrl(CONTROLLER_PUBLIC_URL, row.orgId, row.slug),
    verifyKind: verifyKindFromDb(row.verifyKind),
    hasSecret: Boolean(row.verifySecretEnc),
    target,
    transformTemplate: row.transformTemplate,
    responseTemplate: row.responseTemplate,
    retentionDays: row.retentionDays,
    deliveries24h: stats.deliveries24h,
    lastDeliveryAt: stats.lastDeliveryAt ? stats.lastDeliveryAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toDeliveryView(
  row: DeliveryRow,
  endpoint: { name: string; slug: string; targetKind: string },
): InboundDeliveryView {
  return {
    id: row.id,
    endpointId: row.endpointId,
    endpointName: endpoint.name,
    endpointSlug: endpoint.slug,
    targetKind: (endpoint.targetKind.toLowerCase() === 'queue'
      ? 'queue'
      : 'forward') as InboundTargetKindView,
    receivedAt: row.receivedAt.toISOString(),
    verifyOk: row.verifyOk,
    status: deliveryStatusFromDb(row.status),
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt ? row.nextAttemptAt.toISOString() : null,
    lastError: row.lastError,
    bodyBytes: Buffer.byteLength(row.bodyText, 'utf8'),
  };
}

/** `headersJson` → lowercase-keyed string record (defensive). */
export function parseHeadersJson(json: unknown): Record<string, string> {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
    if (typeof v === 'string') out[k.toLowerCase()] = v;
  }
  return out;
}

// ── Overview + endpoint CRUD ──────────────────────────────────────────────────

/** Aggregates for the Webhooks hero (optionally one stack's endpoints). */
export async function overview(ctx: OrgContext, stack?: string): Promise<InboundWebhooksOverview> {
  const orgId = ctx.activeOrgId;
  const since = new Date(Date.now() - 24 * 3_600_000);
  const scope = stack ? { endpoint: { stackName: stack } } : {};
  const [endpoints, deliveries24h, failed24h, pending, dead] = await Promise.all([
    ctx.db.inboundEndpoint.count({ where: { orgId, ...(stack ? { stackName: stack } : {}) } }),
    ctx.db.inboundDelivery.count({ where: { orgId, receivedAt: { gte: since }, ...scope } }),
    ctx.db.inboundDelivery.count({
      where: { orgId, receivedAt: { gte: since }, status: { in: ['FAILED', 'DEAD'] }, ...scope },
    }),
    ctx.db.inboundDelivery.count({ where: { orgId, status: 'PENDING', ...scope } }),
    ctx.db.inboundDelivery.count({ where: { orgId, status: 'DEAD', ...scope } }),
  ]);
  return { endpoints, deliveries24h, failed24h, pending, dead };
}

export async function listEndpoints(ctx: OrgContext, stack?: string): Promise<InboundEndpointView[]> {
  const orgId = ctx.activeOrgId;
  const since = new Date(Date.now() - 24 * 3_600_000);
  const [rows, counts, lasts] = await Promise.all([
    ctx.db.inboundEndpoint.findMany({
      where: { orgId, ...(stack ? { stackName: stack } : {}) },
      orderBy: { createdAt: 'desc' },
    }),
    ctx.db.inboundDelivery.groupBy({
      by: ['endpointId'],
      where: { orgId, receivedAt: { gte: since } },
      _count: { _all: true },
    }),
    ctx.db.inboundDelivery.groupBy({
      by: ['endpointId'],
      where: { orgId },
      _max: { receivedAt: true },
    }),
  ]);
  const count24 = new Map(counts.map((c) => [c.endpointId, c._count._all]));
  const lastAt = new Map(lasts.map((l) => [l.endpointId, l._max.receivedAt]));
  return rows.map((row) =>
    toEndpointView(row, {
      deliveries24h: count24.get(row.id) ?? 0,
      lastDeliveryAt: lastAt.get(row.id) ?? null,
    }),
  );
}

function requireSecretRule(kind: InboundVerifyKindView, hasSecret: boolean): void {
  if (kind !== 'none' && !hasSecret) {
    throw commandRejected(`verify kind "${kind}" needs a shared secret`);
  }
}

export async function createEndpoint(
  ctx: OrgContext,
  input: CreateInboundEndpointInput & EndpointTemplateFields,
): Promise<InboundEndpointView> {
  requireSecretRule(input.verifyKind, Boolean(input.secret));
  const existing = await ctx.db.inboundEndpoint.findFirst({
    where: { orgId: ctx.activeOrgId, slug: input.slug },
    select: { id: true },
  });
  if (existing) throw commandRejected(`slug "${input.slug}" is already taken in this org`);
  const domain = normalizeEndpointDomain(input.domain) ?? null;
  if (domain) await assertControllerDomainAvailable(ctx, domain);

  const row = await ctx.db.inboundEndpoint.create({
    data: {
      orgId: ctx.activeOrgId,
      name: input.name,
      slug: input.slug,
      stackName: input.stackName ?? null,
      domain,
      verifyKind: VERIFY_TO_DB[input.verifyKind],
      verifySecretEnc:
        input.verifyKind !== 'none' && input.secret ? encryptSecret(input.secret) : null,
      targetKind: input.target.kind === 'queue' ? 'QUEUE' : 'FORWARD',
      targetJson: input.target as object,
      transformTemplate: normalizeTemplate(input.transformTemplate) ?? null,
      responseTemplate: normalizeTemplate(input.responseTemplate) ?? null,
      retentionDays: input.retentionDays,
    },
  });
  await writeAudit(ctx, {
    action: 'inboundWebhooks.createEndpoint',
    targetType: 'inboundEndpoint',
    targetId: row.id,
    metadata: {
      name: input.name,
      slug: input.slug,
      ...(input.stackName ? { stackName: input.stackName } : {}),
      ...(domain ? { domain } : {}),
      verifyKind: input.verifyKind,
      target: input.target,
      retentionDays: input.retentionDays,
      templated: Boolean(row.transformTemplate ?? row.responseTemplate),
    },
  });
  return toEndpointView(row, { deliveries24h: 0, lastDeliveryAt: null });
}

export async function updateEndpoint(
  ctx: OrgContext,
  input: UpdateInboundEndpointInput & Omit<EndpointTemplateFields, 'stackName'> & { stackName?: string | null },
): Promise<InboundEndpointView> {
  const row = await ctx.db.inboundEndpoint.findFirst({
    where: { id: input.id, orgId: ctx.activeOrgId },
  });
  if (!row) throw notFound('inbound endpoint', input.id);

  const nextKind = input.verifyKind ?? verifyKindFromDb(row.verifyKind);
  const nextHasSecret =
    nextKind === 'none' ? false : Boolean(input.secret) || Boolean(row.verifySecretEnc);
  requireSecretRule(nextKind, nextHasSecret);
  const domain = normalizeEndpointDomain(input.domain);
  if (domain) await assertControllerDomainAvailable(ctx, domain, { inboundEndpointId: row.id });

  const updated = await ctx.db.inboundEndpoint.update({
    where: { id: row.id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.verifyKind !== undefined ? { verifyKind: VERIFY_TO_DB[input.verifyKind] } : {}),
      // New secret replaces the stored one; switching to `none` clears it.
      ...(input.secret ? { verifySecretEnc: encryptSecret(input.secret) } : {}),
      ...(nextKind === 'none' ? { verifySecretEnc: null } : {}),
      ...(input.target !== undefined
        ? {
            targetKind: input.target.kind === 'queue' ? 'QUEUE' : 'FORWARD',
            targetJson: input.target as object,
          }
        : {}),
      // Re-home to another stack; null detaches; undefined keeps the value.
      ...(input.stackName !== undefined ? { stackName: input.stackName } : {}),
      // '' clears the domain / a template; undefined keeps the stored value.
      ...(domain !== undefined ? { domain } : {}),
      ...(input.transformTemplate !== undefined
        ? { transformTemplate: normalizeTemplate(input.transformTemplate) }
        : {}),
      ...(input.responseTemplate !== undefined
        ? { responseTemplate: normalizeTemplate(input.responseTemplate) }
        : {}),
      ...(input.retentionDays !== undefined ? { retentionDays: input.retentionDays } : {}),
    },
  });
  await writeAudit(ctx, {
    action: 'inboundWebhooks.updateEndpoint',
    targetType: 'inboundEndpoint',
    targetId: row.id,
    metadata: {
      name: input.name,
      verifyKind: input.verifyKind,
      target: input.target,
      ...(domain !== undefined ? { domain } : {}),
      retentionDays: input.retentionDays,
      secretRotated: Boolean(input.secret),
      templated: Boolean(updated.transformTemplate ?? updated.responseTemplate),
    },
  });
  const since = new Date(Date.now() - 24 * 3_600_000);
  const [deliveries24h, last] = await Promise.all([
    ctx.db.inboundDelivery.count({ where: { endpointId: row.id, receivedAt: { gte: since } } }),
    ctx.db.inboundDelivery.findFirst({
      where: { endpointId: row.id },
      orderBy: { receivedAt: 'desc' },
      select: { receivedAt: true },
    }),
  ]);
  return toEndpointView(updated, { deliveries24h, lastDeliveryAt: last?.receivedAt ?? null });
}

export async function removeEndpoint(
  ctx: OrgContext,
  id: string,
): Promise<{ id: string; removed: true }> {
  const row = await ctx.db.inboundEndpoint.findFirst({
    where: { id, orgId: ctx.activeOrgId },
    select: { id: true, slug: true },
  });
  if (!row) throw notFound('inbound endpoint', id);
  // Deliveries cascade with the endpoint row.
  await ctx.db.inboundEndpoint.delete({ where: { id: row.id } });
  await writeAudit(ctx, {
    action: 'inboundWebhooks.removeEndpoint',
    targetType: 'inboundEndpoint',
    targetId: id,
    metadata: { slug: row.slug },
  });
  return { id, removed: true };
}

// ── Deliveries: feed, payload fetch, replay, retention ───────────────────────

const STATUS_TO_DB: Record<InboundDeliveryStatusView, DbDeliveryStatus> = {
  pending: 'PENDING',
  delivered: 'DELIVERED',
  failed: 'FAILED',
  dead: 'DEAD',
};

export async function listDeliveries(
  ctx: OrgContext,
  input: InboundDeliveriesInput & { stack?: string },
): Promise<InboundDeliveriesPage> {
  const rows = await ctx.db.inboundDelivery.findMany({
    where: {
      orgId: ctx.activeOrgId,
      ...(input.endpointId ? { endpointId: input.endpointId } : {}),
      ...(input.stack ? { endpoint: { stackName: input.stack } } : {}),
      ...(input.status ? { status: STATUS_TO_DB[input.status] } : {}),
    },
    include: { endpoint: { select: { name: true, slug: true, targetKind: true } } },
    orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
    take: input.limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, input.limit);
  return {
    deliveries: page.map((row) => toDeliveryView(row, row.endpoint)),
    nextCursor: rows.length > input.limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}

/** Payload inspector: one delivery with captured headers + the raw body. */
export async function getDelivery(
  ctx: OrgContext,
  id: string,
): Promise<InboundDeliveryDetailView> {
  const row = await ctx.db.inboundDelivery.findFirst({
    where: { id, orgId: ctx.activeOrgId },
    include: { endpoint: { select: { name: true, slug: true, targetKind: true } } },
  });
  if (!row) throw notFound('delivery', id);
  return {
    ...toDeliveryView(row, row.endpoint),
    headers: parseHeadersJson(row.headersJson),
    body: row.bodyText,
  };
}

/**
 * Replay: reset the delivery to PENDING so the dispatch worker picks it up on
 * its next tick. The attempt log is kept unchanged — a replayed DEAD delivery
 * gets exactly one more attempt before going DEAD again.
 */
export async function replayDelivery(ctx: OrgContext, id: string): Promise<InboundDeliveryView> {
  const row = await ctx.db.inboundDelivery.findFirst({
    where: { id, orgId: ctx.activeOrgId },
    include: { endpoint: { select: { name: true, slug: true, targetKind: true } } },
  });
  if (!row) throw notFound('delivery', id);
  if (!row.verifyOk) throw commandRejected('cannot replay a delivery that failed verification');
  const updated = await ctx.db.inboundDelivery.update({
    where: { id: row.id },
    data: { status: 'PENDING', nextAttemptAt: new Date() },
  });
  await writeAudit(ctx, {
    action: 'inboundWebhooks.replay',
    targetType: 'inboundDelivery',
    targetId: id,
    metadata: { endpointId: row.endpointId, attempts: row.attempts, wasStatus: row.status },
  });
  return toDeliveryView(updated, row.endpoint);
}

/** Delete deliveries older than each endpoint's `retentionDays` (audited). */
export async function deleteOldDeliveries(ctx: OrgContext): Promise<{ removed: number }> {
  const endpoints = await ctx.db.inboundEndpoint.findMany({
    where: { orgId: ctx.activeOrgId },
    select: { id: true, retentionDays: true },
  });
  let removed = 0;
  for (const ep of endpoints) {
    const cutoff = new Date(Date.now() - ep.retentionDays * 24 * 3_600_000);
    const res = await ctx.db.inboundDelivery.deleteMany({
      where: { endpointId: ep.id, receivedAt: { lt: cutoff } },
    });
    removed += res.count;
  }
  if (removed > 0) {
    await writeAudit(ctx, {
      action: 'inboundWebhooks.pruneOld',
      targetType: 'inboundDelivery',
      metadata: { removed },
    });
  }
  return { removed };
}
