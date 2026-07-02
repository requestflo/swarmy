/**
 * Inbound webhook gateway receiver (spine stub — owned by slice B4 webhook-gateway).
 *
 * `POST /hooks/i/:orgId/:slug` — the public front door for third-party webhooks
 * (Stripe, GitHub, custom HMAC, …). B4 will: look up the org's `InboundEndpoint`
 * by slug, verify the payload (hmac/github/stripe), persist an `InboundDelivery`
 * row and respond 202 — delivery to queue/forward targets happens in the
 * `inbound-webhook-dispatch` worker.
 *
 * Mounted at `/hooks` in apps/api/src/index.ts. Inert 501 until B4 lands.
 */
import { Hono } from 'hono';

export const inboundHooksApp = new Hono();

inboundHooksApp.post('/i/:orgId/:slug', (c) => c.json({ error: 'not ready' }, 501));
