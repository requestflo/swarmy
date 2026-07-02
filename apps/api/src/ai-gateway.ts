/**
 * AI gateway (spine stub — owned by slice F5 ai).
 *
 * `POST /ai/v1/messages | /ai/v1/chat/completions | /ai/v1/embeddings` — the
 * provider-shaped proxy apps call with an `x-swarmy-ai-key` virtual key. F5
 * will: authenticate the `AiVirtualKey` hash, route by model prefix to the
 * org's configured provider (creds from `AiProviderConfig` vault), enforce
 * budget/RPM limits from rolling `AiUsage`, log usage (+`AiRequestLog` when
 * audit is on), and serve the optional exact-match cache.
 *
 * Mounted at `/ai` in apps/api/src/index.ts. Inert 501 until F5 lands.
 */
import { Hono } from 'hono';

export const aiGatewayApp = new Hono();

aiGatewayApp.post('/v1/*', (c) => c.json({ error: 'not ready' }, 501));
