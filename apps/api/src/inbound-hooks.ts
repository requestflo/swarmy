/**
 * Inbound webhook gateway receiver (slice B4 webhook-gateway).
 *
 * `POST /hooks/i/:orgId/:slug` — the public front door for third-party webhooks
 * (Stripe, GitHub, custom HMAC, …):
 *
 *   1. Resolve the org's `InboundEndpoint` by slug (404 when unknown).
 *   2. Read the raw body, capped at 256KB (413 above — nothing persisted).
 *   3. Verify per `verifyKind` — hmac: `X-Signature: sha256=…` of the raw body;
 *      github: `X-Hub-Signature-256`; stripe: `Stripe-Signature: t=…,v1=…` with
 *      a 300s tolerance. The shared secret is decrypted JIT from the vault.
 *   4. Persist an `InboundDelivery` (verified → PENDING + due now for the
 *      `inbound-webhook-dispatch` worker; failed → FAILED, kept for the audit
 *      trail) and answer 202 / 401.
 *
 * The verification helpers here are documented MIRRORS of the unit-tested
 * canonical copies in `@swarmy/trpc` `inboundWebhooks.service.ts` (this app can
 * only import the trpc package root, which does not export them). Keep in sync.
 *
 * Mounted at `/hooks` in apps/api/src/index.ts.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { decryptSecret } from '@swarmy/core/crypto';
import { prisma } from '@swarmy/db';
import { renderInboundTemplate, templateContentType } from './inbound-template';

/** Max raw body persisted per delivery (mirror of INBOUND_BODY_MAX_BYTES). */
const BODY_MAX_BYTES = 256 * 1024;
/** Stripe timestamp tolerance in seconds (mirror of STRIPE_TOLERANCE_SECONDS). */
const STRIPE_TOLERANCE_SECONDS = 300;

// ── Verification (mirror of inboundWebhooks.service.ts — the tested copies) ───

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** `sha256=<hex hmac of raw body>` — generic HMAC and GitHub scheme. */
function verifySha256Header(secret: string, rawBody: string, header: string | undefined): boolean {
  if (!secret || !header) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
  return safeEqual(header.trim(), expected);
}

/** Stripe: HMAC of `<t>.<body>` must match a `v1`, with `t` within tolerance. */
function verifyStripeHeader(secret: string, rawBody: string, header: string | undefined): boolean {
  if (!secret || !header) return false;
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    if (key === 't') {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n)) t = n;
    } else if (key === 'v1' && value) {
      v1.push(value);
    }
  }
  if (t === null || v1.length === 0) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - t) > STRIPE_TOLERANCE_SECONDS) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest('hex');
  return v1.some((sig) => safeEqual(sig, expected));
}

/** Verify per the endpoint's kind; verifying kinds fail closed w/o a secret. */
function verifyDelivery(
  verifyKind: string,
  secretEnc: string | null,
  rawBody: string,
  headers: Record<string, string>,
): boolean {
  const kind = verifyKind.toLowerCase();
  if (kind === 'none') return true;
  if (!secretEnc) return false;
  let secret: string;
  try {
    secret = decryptSecret(secretEnc);
  } catch {
    return false;
  }
  if (kind === 'hmac') return verifySha256Header(secret, rawBody, headers['x-signature']);
  if (kind === 'github') return verifySha256Header(secret, rawBody, headers['x-hub-signature-256']);
  if (kind === 'stripe') return verifyStripeHeader(secret, rawBody, headers['stripe-signature']);
  return false;
}

// ── Header capture (lowercase keys; secrets-adjacent headers redacted) ────────

const REDACTED_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);

function captureHeaders(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = k.toLowerCase();
    out[key] = REDACTED_HEADERS.has(key) ? '[redacted]' : v;
  }
  return out;
}

// ── Route ─────────────────────────────────────────────────────────────────────

export const inboundHooksApp = new Hono();

inboundHooksApp.post('/i/:orgId/:slug', async (c) => {
  const orgId = c.req.param('orgId');
  const slug = c.req.param('slug');

  const endpoint = await prisma.inboundEndpoint.findUnique({
    where: { orgId_slug: { orgId, slug } },
    select: { id: true, orgId: true, verifyKind: true, verifySecretEnc: true, responseTemplate: true },
  });
  if (!endpoint) return c.json({ error: 'unknown endpoint' }, 404);

  // Cheap reject on the declared length, then enforce on the actual bytes.
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > BODY_MAX_BYTES) return c.json({ error: 'payload too large' }, 413);
  const rawBody = await c.req.text();
  if (Buffer.byteLength(rawBody, 'utf8') > BODY_MAX_BYTES) {
    return c.json({ error: 'payload too large' }, 413);
  }

  const headers = captureHeaders(c.req.header());
  const verifyOk = verifyDelivery(endpoint.verifyKind, endpoint.verifySecretEnc, rawBody, headers);

  // Persist either way — failed verifications stay visible in the feed.
  const now = new Date();
  const delivery = await prisma.inboundDelivery.create({
    data: {
      orgId: endpoint.orgId,
      endpointId: endpoint.id,
      receivedAt: now,
      headersJson: headers,
      bodyText: rawBody,
      verifyOk,
      status: verifyOk ? 'PENDING' : 'FAILED',
      attempts: 0,
      nextAttemptAt: verifyOk ? now : null,
      ...(verifyOk ? {} : { lastError: 'signature verification failed' }),
    },
    select: { id: true },
  });

  if (!verifyOk) return c.json({ error: 'invalid signature', deliveryId: delivery.id }, 401);

  // Templated ack: same 202, the endpoint's responseTemplate shapes the body
  // ({{body}}, {{headers.x}}, {{json.path}}, {{slug}}, {{deliveryId}}).
  if (endpoint.responseTemplate) {
    const rendered = renderInboundTemplate(endpoint.responseTemplate, {
      body: rawBody,
      headers,
      slug,
      deliveryId: delivery.id,
    });
    return c.body(rendered, 202, { 'content-type': templateContentType(rendered) });
  }
  return c.json({ ok: true, deliveryId: delivery.id }, 202);
});
