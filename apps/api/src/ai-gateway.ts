/**
 * AI gateway data plane (slice F5 ai).
 *
 * `POST /ai/v1/messages | /ai/v1/chat/completions | /ai/v1/embeddings` — the
 * provider-shaped proxy apps call with an `x-swarmy-ai-key` virtual key:
 *
 *   1. Auth: sha-256 the presented key → `AiVirtualKey.keyHash` (401 unknown,
 *      403 disabled).
 *   2. Route: model prefix → provider (claude… → anthropic, gpt…/o-series →
 *      openai, else the org's default provider). Creds come vault-decrypted
 *      from `AiProviderConfig.configEnc` — they never reach the app.
 *   3. Limits: per-key `limitsJson` — RPM via an in-memory sliding window,
 *      daily budget via today's `AiUsage` cost sum → 429.
 *   4. Proxy: streaming SSE passes through untouched (body piped, a bounded
 *      tail buffered for best-effort usage parse); non-streaming responses are
 *      parsed for provider usage tokens.
 *   5. Meter: static $/MTok table → cost ESTIMATE, one `AiUsage` row per
 *      request (+`AiRequestLog` with a 200-char redacted prompt when the org's
 *      audit toggle is on).
 *   6. Cache: optional exact-body-match LRU (non-streaming only, 5 min TTL,
 *      100 entries) when the org's cache toggle is on.
 *
 * Control plane (providers/keys/usage queries) lives in @swarmy/trpc
 * `ai.service.ts`. The pure helpers below are unit-tested in
 * `ai-gateway.test.ts`; the config-doc parser is a documented MIRROR of the
 * tested canonical copy in ai.service.ts (this app can only import the trpc
 * package root — same constraint inbound-hooks.ts documents). Keep in sync.
 *
 * Mounted at `/ai` in apps/api/src/index.ts.
 */
import { createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { decryptSecret } from '@swarmy/core/crypto';
import { prisma } from '@swarmy/db';

// ── Pure: model → provider routing ───────────────────────────────────────────

export type ProviderKind = 'anthropic' | 'openai' | 'custom';
const PROVIDER_KINDS: readonly string[] = ['anthropic', 'openai', 'custom'];

export interface ProviderDescriptor {
  kind: ProviderKind;
  baseUrl: string | null;
  isDefault: boolean;
}

/**
 * Route a model id to a provider kind: `claude*` → anthropic, `gpt*` /
 * o-series (`o1`/`o3`/`o4-mini`…) / embeddings → openai, anything else → the
 * configured default provider (else custom, else the first configured).
 * Returns null when nothing is configured to take the model.
 */
export function resolveProviderKind(
  model: string,
  configured: ProviderDescriptor[],
): ProviderKind | null {
  const m = model.toLowerCase();
  const has = (kind: ProviderKind): boolean => configured.some((p) => p.kind === kind);
  if (m.startsWith('claude')) return has('anthropic') ? 'anthropic' : fallback();
  if (m.startsWith('gpt') || /^o\d/.test(m) || m.startsWith('text-embedding') || m.startsWith('chatgpt')) {
    return has('openai') ? 'openai' : fallback();
  }
  return fallback();

  function fallback(): ProviderKind | null {
    const def = configured.find((p) => p.isDefault);
    if (def) return def.kind;
    if (has('custom')) return 'custom';
    return configured[0]?.kind ?? null;
  }
}

// ── Pure: cost table (static $/MTok — always an ESTIMATE) ─────────────────────

/** $/MTok == micro-dollars per token. Longest-prefix match wins. */
const COST_PER_MTOK: Array<{ prefix: string; inUsd: number; outUsd: number }> = [
  // Anthropic (per platform.claude.com pricing)
  { prefix: 'claude-fable-5', inUsd: 10, outUsd: 50 },
  { prefix: 'claude-opus', inUsd: 5, outUsd: 25 },
  { prefix: 'claude-sonnet', inUsd: 3, outUsd: 15 },
  { prefix: 'claude-haiku', inUsd: 1, outUsd: 5 },
  { prefix: 'claude', inUsd: 5, outUsd: 25 },
  // OpenAI
  { prefix: 'gpt-4o-mini', inUsd: 0.15, outUsd: 0.6 },
  { prefix: 'gpt-4o', inUsd: 2.5, outUsd: 10 },
  { prefix: 'gpt-4.1-nano', inUsd: 0.1, outUsd: 0.4 },
  { prefix: 'gpt-4.1-mini', inUsd: 0.4, outUsd: 1.6 },
  { prefix: 'gpt-4.1', inUsd: 2, outUsd: 8 },
  { prefix: 'o4-mini', inUsd: 1.1, outUsd: 4.4 },
  { prefix: 'o3', inUsd: 2, outUsd: 8 },
  { prefix: 'o1', inUsd: 15, outUsd: 60 },
  { prefix: 'text-embedding-3-small', inUsd: 0.02, outUsd: 0 },
  { prefix: 'text-embedding-3-large', inUsd: 0.13, outUsd: 0 },
  { prefix: 'text-embedding', inUsd: 0.1, outUsd: 0 },
];
/** Unknown models bill at a modest middle rate — still marked estimate. */
const DEFAULT_RATE = { inUsd: 2, outUsd: 8 };

/** Estimated cost in micro-dollars (1e-6 USD). Rates are $/MTok = µ$/token. */
export function costMicros(model: string, inTokens: number, outTokens: number): number {
  const m = model.toLowerCase();
  const rate =
    [...COST_PER_MTOK].sort((a, b) => b.prefix.length - a.prefix.length).find((r) => m.startsWith(r.prefix)) ??
    DEFAULT_RATE;
  return Math.round(inTokens * rate.inUsd + outTokens * rate.outUsd);
}

// ── Pure: RPM sliding window ──────────────────────────────────────────────────

/** In-memory per-key sliding 60s window. Controller-local (single process). */
export class RpmWindow {
  private hits = new Map<string, number[]>();

  /** Record + allow if under `rpm` in the last 60s. */
  allow(keyId: string, rpm: number, now = Date.now()): boolean {
    const kept = (this.hits.get(keyId) ?? []).filter((t) => now - t < 60_000);
    if (kept.length >= rpm) {
      this.hits.set(keyId, kept);
      return false;
    }
    kept.push(now);
    this.hits.set(keyId, kept);
    return true;
  }
}

// ── Pure: exact-match response cache (LRU 100, TTL 5m, non-stream only) ───────

export interface CachedResponse {
  status: number;
  contentType: string;
  body: string;
  inTokens: number;
  outTokens: number;
}

export class TtlLruCache<V> {
  private map = new Map<string, { value: V; at: number }>();
  constructor(
    private readonly max = 100,
    private readonly ttlMs = 5 * 60_000,
  ) {}

  get(key: string, now = Date.now()): V | null {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (now - hit.at > this.ttlMs) {
      this.map.delete(key);
      return null;
    }
    // Refresh recency (Map preserves insertion order).
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V, now = Date.now()): void {
    this.map.delete(key);
    this.map.set(key, { value, at: now });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}

// ── Pure: usage parsing (both providers return usage; streams best-effort) ────

export interface ParsedUsage {
  inTokens: number;
  outTokens: number;
}

/** Non-streaming response body → usage tokens (anthropic + openai shapes). */
export function parseUsageJson(provider: ProviderKind, body: unknown): ParsedUsage | null {
  const usage = (body as { usage?: Record<string, unknown> } | null)?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const num = (k: string): number | null =>
    typeof usage[k] === 'number' && Number.isFinite(usage[k]) ? (usage[k] as number) : null;
  if (provider === 'anthropic') {
    const inTok = num('input_tokens');
    const outTok = num('output_tokens');
    if (inTok === null && outTok === null) return null;
    return { inTokens: inTok ?? 0, outTokens: outTok ?? 0 };
  }
  const inTok = num('prompt_tokens');
  const outTok = num('completion_tokens');
  if (inTok === null && outTok === null) return null;
  return { inTokens: inTok ?? 0, outTokens: outTok ?? 0 };
}

/**
 * Best-effort usage from an SSE tail: anthropic streams carry
 * `message_start.usage.input_tokens` + a final `message_delta.usage
 * .output_tokens`; openai includes a final usage chunk when the caller sets
 * `stream_options.include_usage`. Returns null when nothing parseable is left
 * in the (bounded) tail.
 */
export function parseUsageFromSse(provider: ProviderKind, sseText: string): ParsedUsage | null {
  let inTokens: number | null = null;
  let outTokens: number | null = null;
  for (const line of sseText.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (provider === 'anthropic') {
      const message = json.message as { usage?: Record<string, unknown> } | undefined;
      const mu = message?.usage;
      if (mu && typeof mu.input_tokens === 'number') inTokens = mu.input_tokens;
      const du = json.usage as Record<string, unknown> | undefined;
      if (du && typeof du.output_tokens === 'number') outTokens = du.output_tokens;
      if (du && typeof du.input_tokens === 'number') inTokens = du.input_tokens;
    } else {
      const u = json.usage as Record<string, unknown> | null | undefined;
      if (u && typeof u === 'object') {
        if (typeof u.prompt_tokens === 'number') inTokens = u.prompt_tokens;
        if (typeof u.completion_tokens === 'number') outTokens = u.completion_tokens;
      }
    }
  }
  if (inTokens === null && outTokens === null) return null;
  return { inTokens: inTokens ?? 0, outTokens: outTokens ?? 0 };
}

/** Crude ~4 chars/token estimate for when a stream carried no usage. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Redacted prompt for the audit log: the last user message's text (chat/
 * messages shapes) or the embeddings input — hard-capped at 200 chars.
 */
export function redactPrompt(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { messages?: unknown; input?: unknown; prompt?: unknown };
  let text: string | null = null;
  if (Array.isArray(b.messages)) {
    for (let i = b.messages.length - 1; i >= 0; i--) {
      const m = b.messages[i] as { role?: unknown; content?: unknown };
      if (m?.role !== 'user') continue;
      if (typeof m.content === 'string') text = m.content;
      else if (Array.isArray(m.content)) {
        text = m.content
          .map((c) => (typeof (c as { text?: unknown })?.text === 'string' ? (c as { text: string }).text : ''))
          .filter(Boolean)
          .join(' ');
      }
      break;
    }
  } else if (typeof b.input === 'string') {
    text = b.input;
  } else if (Array.isArray(b.input)) {
    text = b.input.filter((x) => typeof x === 'string').join(' ');
  } else if (typeof b.prompt === 'string') {
    text = b.prompt;
  }
  if (!text) return null;
  const t = text.trim();
  return t ? t.slice(0, 200) : null;
}

/** UTC start-of-day for the daily budget window. */
export function startOfUtcDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Parse `AiVirtualKey.limitsJson` → gateway limits (invalid → unlimited). */
export function keyLimits(limitsJson: unknown): { rpm: number | null; dailyBudgetMicros: number | null } {
  const o = limitsJson && typeof limitsJson === 'object' ? (limitsJson as Record<string, unknown>) : {};
  const rpm = typeof o.rpm === 'number' && Number.isFinite(o.rpm) && o.rpm > 0 ? Math.floor(o.rpm) : null;
  const budget =
    typeof o.dailyBudgetMicros === 'number' && Number.isFinite(o.dailyBudgetMicros) && o.dailyBudgetMicros > 0
      ? o.dailyBudgetMicros
      : null;
  return { rpm, dailyBudgetMicros: budget };
}

/** True when today's estimated spend has reached the key's daily budget. */
export function budgetExhausted(spentMicros: number | bigint, dailyBudgetMicros: number | null): boolean {
  if (dailyBudgetMicros === null) return false;
  return Number(spentMicros) >= dailyBudgetMicros;
}

// ── Config parsing (MIRROR of @swarmy/trpc ai.service.ts parseConfigDoc) ──────

interface GatewayConfig {
  providers: ProviderDescriptor[];
  settings: { auditLog: boolean; cache: boolean };
  keys: Partial<Record<ProviderKind, string>>;
}

export function parseGatewayConfig(providersJson: unknown, configEnc: string | null): GatewayConfig {
  const out: GatewayConfig = {
    providers: [],
    settings: { auditLog: false, cache: false },
    keys: {},
  };
  const list = Array.isArray(providersJson)
    ? providersJson
    : providersJson &&
        typeof providersJson === 'object' &&
        Array.isArray((providersJson as { providers?: unknown }).providers)
      ? ((providersJson as { providers: unknown[] }).providers)
      : [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { kind?: unknown; baseUrl?: unknown; isDefault?: unknown };
    if (typeof e.kind !== 'string' || !PROVIDER_KINDS.includes(e.kind)) continue;
    if (out.providers.some((p) => p.kind === e.kind)) continue;
    out.providers.push({
      kind: e.kind as ProviderKind,
      baseUrl: typeof e.baseUrl === 'string' && e.baseUrl.trim() ? e.baseUrl.trim().replace(/\/+$/, '') : null,
      isDefault: e.isDefault === true,
    });
  }
  const s = (providersJson as { settings?: unknown } | null | undefined)?.settings;
  if (s && typeof s === 'object') {
    const st = s as { auditLog?: unknown; cache?: unknown };
    out.settings = { auditLog: st.auditLog === true, cache: st.cache === true };
  }
  if (configEnc) {
    try {
      const parsed = JSON.parse(decryptSecret(configEnc)) as Record<string, unknown>;
      for (const kind of PROVIDER_KINDS as ProviderKind[]) {
        if (typeof parsed[kind] === 'string' && parsed[kind]) out.keys[kind] = parsed[kind] as string;
      }
    } catch {
      // Undecryptable creds: behave as "no key stored".
    }
  }
  return out;
}

// ── Upstream request shaping ──────────────────────────────────────────────────

const PROVIDER_DEFAULT_BASE: Record<ProviderKind, string | null> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
  custom: null,
};

export function upstreamHeaders(provider: ProviderKind, apiKey: string): Record<string, string> {
  if (provider === 'anthropic') {
    return {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    };
  }
  return { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` };
}

// ── The gateway app ───────────────────────────────────────────────────────────

const BODY_MAX_BYTES = 10 * 1024 * 1024;
const SSE_TAIL_MAX = 64 * 1024;
const UPSTREAM_TIMEOUT_MS = 600_000;

const rpmWindow = new RpmWindow();
const responseCache = new TtlLruCache<CachedResponse>(100, 5 * 60_000);

function err(c: Context, status: 400 | 401 | 403 | 404 | 429 | 500 | 502, message: string): Response {
  return c.json({ error: { type: 'swarmy_gateway_error', message } }, status);
}

interface UsageRecord {
  orgId: string;
  keyId: string;
  provider: string;
  model: string;
  inTokens: number;
  outTokens: number;
  latencyMs: number;
  status: string;
  cacheHit: boolean;
  auditOn: boolean;
  promptRedacted: string | null;
}

/** Write AiUsage (+AiRequestLog when the audit toggle is on). Best-effort. */
async function recordUsage(r: UsageRecord): Promise<void> {
  const cost = r.cacheHit ? 0 : costMicros(r.model, r.inTokens, r.outTokens);
  try {
    await prisma.aiUsage.create({
      data: {
        orgId: r.orgId,
        keyId: r.keyId,
        provider: r.provider,
        model: r.model,
        inTokens: r.inTokens,
        outTokens: r.outTokens,
        costMicros: BigInt(cost),
        latencyMs: r.latencyMs,
        status: r.status,
        cacheHit: r.cacheHit,
      },
    });
    if (r.auditOn) {
      await prisma.aiRequestLog.create({
        data: {
          orgId: r.orgId,
          keyId: r.keyId,
          model: r.model,
          promptRedacted: r.promptRedacted,
          meta: {
            provider: r.provider,
            status: r.status,
            latencyMs: r.latencyMs,
            inTokens: r.inTokens,
            outTokens: r.outTokens,
            costMicros: cost,
            cacheHit: r.cacheHit,
          },
        },
      });
    }
  } catch {
    // Metering must never break the proxied request.
  }
}

async function proxy(c: Context): Promise<Response> {
  const started = Date.now();
  // Suffix under the /ai mount: /v1/messages | /v1/chat/completions | /v1/embeddings.
  const path = c.req.path.replace(/^\/ai/, '');

  // (1) Auth by virtual key hash.
  const presented = c.req.header('x-swarmy-ai-key')?.trim();
  if (!presented) return err(c, 401, 'missing x-swarmy-ai-key header');
  const keyRow = await prisma.aiVirtualKey.findUnique({
    where: { keyHash: createHash('sha256').update(presented).digest('hex') },
  });
  if (!keyRow) return err(c, 401, 'unknown key');
  if (keyRow.disabled) return err(c, 403, 'key disabled');

  // (2) Body + model.
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > BODY_MAX_BYTES) return err(c, 400, 'request body too large');
  const rawBody = await c.req.text();
  if (rawBody.length > BODY_MAX_BYTES) return err(c, 400, 'request body too large');
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return err(c, 400, 'body must be JSON');
  }
  const model = typeof body.model === 'string' ? body.model : '';
  if (!model) return err(c, 400, 'missing "model"');
  const wantsStream = body.stream === true;

  // (3) Provider config + routing.
  const cfgRow = await prisma.aiProviderConfig.findUnique({ where: { orgId: keyRow.orgId } });
  const cfg = parseGatewayConfig(cfgRow?.providersJson ?? [], cfgRow?.configEnc ?? null);
  if (cfg.providers.length === 0) return err(c, 400, 'no AI provider configured for this org');
  const kind = resolveProviderKind(model, cfg.providers);
  if (!kind) return err(c, 400, `no provider configured for model "${model}"`);
  const descriptor = cfg.providers.find((p) => p.kind === kind);
  const apiKey = cfg.keys[kind];
  if (!apiKey) return err(c, 400, `provider "${kind}" has no API key stored`);
  const baseUrl = descriptor?.baseUrl ?? PROVIDER_DEFAULT_BASE[kind];
  if (!baseUrl) return err(c, 400, `provider "${kind}" has no base URL`);

  // (4) Limits.
  const limits = keyLimits(keyRow.limitsJson);
  if (limits.rpm !== null && !rpmWindow.allow(keyRow.id, limits.rpm)) {
    return err(c, 429, `rate limit exceeded (${limits.rpm} requests/minute)`);
  }
  if (limits.dailyBudgetMicros !== null) {
    const spent = await prisma.aiUsage.aggregate({
      where: { keyId: keyRow.id, at: { gte: startOfUtcDay() } },
      _sum: { costMicros: true },
    });
    if (budgetExhausted(spent._sum.costMicros ?? 0n, limits.dailyBudgetMicros)) {
      return err(c, 429, 'daily budget exhausted for this key');
    }
  }

  const promptRedacted = cfg.settings.auditLog ? redactPrompt(body) : null;

  // (5) Cache (exact body match; non-streaming only; org+path scoped).
  const cacheKey = createHash('sha256').update(`${keyRow.orgId}\n${path}\n${rawBody}`).digest('hex');
  if (cfg.settings.cache && !wantsStream) {
    const hit = responseCache.get(cacheKey);
    if (hit) {
      void recordUsage({
        orgId: keyRow.orgId,
        keyId: keyRow.id,
        provider: kind,
        model,
        inTokens: hit.inTokens,
        outTokens: hit.outTokens,
        latencyMs: Date.now() - started,
        status: 'ok',
        cacheHit: true,
        auditOn: cfg.settings.auditLog,
        promptRedacted,
      });
      return c.newResponse(hit.body, hit.status as 200, {
        'content-type': hit.contentType,
        'x-swarmy-ai-cache': 'hit',
      });
    }
  }

  // (6) Proxy upstream.
  let upstream: Response;
  try {
    upstream = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: upstreamHeaders(kind, apiKey),
      body: rawBody,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (e) {
    void recordUsage({
      orgId: keyRow.orgId,
      keyId: keyRow.id,
      provider: kind,
      model,
      inTokens: 0,
      outTokens: 0,
      latencyMs: Date.now() - started,
      status: 'error',
      cacheHit: false,
      auditOn: cfg.settings.auditLog,
      promptRedacted,
    });
    return err(c, 502, `upstream unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }

  const contentType = upstream.headers.get('content-type') ?? 'application/json';

  // (6a) Streaming SSE passthrough — pipe the body, keep a bounded tail for
  // best-effort usage parsing when the stream ends.
  if (wantsStream && upstream.ok && upstream.body && contentType.includes('text/event-stream')) {
    let tail = '';
    const decoder = new TextDecoder();
    const finalize = (): void => {
      const usage = parseUsageFromSse(kind, tail) ?? {
        inTokens: estimateTokens(rawBody),
        outTokens: estimateTokens(tail),
      };
      void recordUsage({
        orgId: keyRow.orgId,
        keyId: keyRow.id,
        provider: kind,
        model,
        inTokens: usage.inTokens,
        outTokens: usage.outTokens,
        latencyMs: Date.now() - started,
        status: 'ok',
        cacheHit: false,
        auditOn: cfg.settings.auditLog,
        promptRedacted,
      });
    };
    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        tail = (tail + decoder.decode(chunk, { stream: true })).slice(-SSE_TAIL_MAX);
      },
      flush() {
        finalize();
      },
    });
    // Bun's fetch types widen body chunks to `Uint8Array | undefined` — the
    // runtime stream is plain bytes, so narrow it for the passthrough pipe.
    const piped = (upstream.body as unknown as ReadableStream<Uint8Array>).pipeThrough(transform);
    return new Response(piped as unknown as ConstructorParameters<typeof Response>[0], {
      status: upstream.status,
      headers: { 'content-type': contentType, 'cache-control': 'no-store' },
    });
  }

  // (6b) Non-streaming: parse usage, meter, optionally cache, pass through.
  const text = await upstream.text();
  const latencyMs = Date.now() - started;
  let usage: ParsedUsage | null = null;
  if (contentType.includes('json')) {
    try {
      usage = parseUsageJson(kind, JSON.parse(text));
    } catch {
      usage = null;
    }
  }
  const inTokens = usage?.inTokens ?? (upstream.ok ? estimateTokens(rawBody) : 0);
  const outTokens = usage?.outTokens ?? 0;
  void recordUsage({
    orgId: keyRow.orgId,
    keyId: keyRow.id,
    provider: kind,
    model,
    inTokens,
    outTokens,
    latencyMs,
    status: upstream.ok ? 'ok' : `error:${upstream.status}`,
    cacheHit: false,
    auditOn: cfg.settings.auditLog,
    promptRedacted,
  });
  if (cfg.settings.cache && upstream.ok) {
    responseCache.set(cacheKey, { status: upstream.status, contentType, body: text, inTokens, outTokens });
  }
  return c.newResponse(text, upstream.status as 200, { 'content-type': contentType });
}

export const aiGatewayApp = new Hono();

aiGatewayApp.post('/v1/messages', proxy);
aiGatewayApp.post('/v1/chat/completions', proxy);
aiGatewayApp.post('/v1/embeddings', proxy);
aiGatewayApp.all('/v1/*', (c) =>
  c.json({ error: { type: 'swarmy_gateway_error', message: 'unsupported endpoint' } }, 404),
);
