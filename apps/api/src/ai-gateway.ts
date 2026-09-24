/**
 * AI gateway data plane — the LiteLLM-class proxy apps call instead of
 * holding provider keys.
 *
 *   POST /ai/v1/chat/completions   OpenAI-compatible; translated to EVERY provider
 *   POST /ai/v1/embeddings         OpenAI-compatible; OpenAI-shaped, Gemini, Bedrock Titan
 *   POST /ai/v1/messages           native Anthropic (passthrough to Anthropic,
 *                                  translated for any other provider)
 *   GET  /ai/v1/models             what this key may call
 *
 * Per request:
 *   1. Auth — the virtual key (`x-swarmy-ai-key`, `Authorization: Bearer`,
 *      `x-api-key` or `api-key`, so stock OpenAI/Anthropic SDKs work) →
 *      sha-256 → AiVirtualKey (401 unknown, 403 disabled).
 *   2. Resolve — alias (`fast`/`smart`/`embed`/org routes) or model id →
 *      ordered provider targets (@swarmy/core `resolveModel`), in-cluster
 *      Ollama/vLLM auto-registered from the live inventory.
 *   3. Policy — key + app model allowlists, ABAC `ai.use` on the model for the
 *      member who minted the key, prompt-size cap, RPM + daily budget.
 *   4. Call — retries with backoff, fallbacks/load-balancing across targets
 *      (ai/router.ts), translation per provider (ai/adapters.ts), streaming
 *      SSE re-encoded chunk by chunk.
 *   5. Meter + trace — one AiUsage row (cost ESTIMATE from the catalogue),
 *      an optional redacted AiRequestLog row, OTel GenAI spans linked to the
 *      caller's `traceparent`.
 *
 * Control plane: @swarmy/trpc `ai.service.ts`. Mounted at `/ai`.
 */
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  AI_PROVIDERS,
  AI_PROVIDER_KINDS,
  MODEL_CATALOG,
  aiModelResource,
  checkProviderUrl,
  costMicros,
  discoverInClusterModels,
  effectiveRoutes,
  estimatePromptTokens,
  modelAllowed,
  orderTargets,
  parseConfigDoc,
  parseKeyPolicy,
  redactPii,
  probeModel,
  registerAiGatewayRunner,
  registerAiProviderProbe,
  resolveModel,
  withDiscovered,
  type AiConfigDoc,
  type AiGatewayRunInput,
  type AiGatewayRunOutput,
  type AiKeyPolicy,
  type AiProviderKind,
  type AiRouteTarget,
  type HostResolver,
  type ResolvedModel,
} from '@swarmy/core/views';
import { decryptSecret } from '@swarmy/core/crypto';
import { prisma } from '@swarmy/db';
import { canPrincipal } from '@swarmy/trpc';
import { hub } from './gateway';
import { AdapterError, baseUrlOf, AZURE_DEFAULT_API_VERSION, buildChat, buildEmbed, chatStream, otelProviderName, parseChat, parseEmbed, type StreamTranslator, type Target, type Upstream } from './ai/adapters';
import { anthropicToOpenAIRequest, openAIToAnthropicResponse, OpenAIToAnthropicStream, AnthropicToOpenAIStream, anthropicInputTokens, ANTHROPIC_DEFAULT_MAX_TOKENS } from './ai/anthropic';
import { AwsEventStreamDecoder, SseDecoder, encodeSse } from './ai/framing';
import { DEFAULT_RETRY, TargetHealth, parseRetryAfter, runChain, type AttemptResult, type RetryOptions } from './ai/router';
import { SpanExporter, formatTraceparent, genAiAttributes, newSpanId, parseTraceparent, type SpanRecord, type TraceContext } from './ai/trace';
import type { ChatChunk, ChatRequest, EmbeddingRequest } from './ai/wire';

export { costMicros };

// ── Pure helpers (tested in ai-gateway.test.ts) ──────────────────────────────

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

export interface CachedResponse {
  status: number;
  contentType: string;
  body: string;
  inTokens: number;
  outTokens: number;
  provider: string;
  model: string;
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

/** Crude ~4 chars/token estimate for when a provider returns no usage. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * The prompt for the audit log: the last user message's text (chat/messages
 * shapes) or the embeddings input — hard-capped at 200 chars. PII redaction
 * (the log guardrail) is applied by the caller.
 */
export function redactPrompt(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { messages?: unknown; input?: unknown; prompt?: unknown };
  let text: string | null = null;
  if (Array.isArray(b.messages)) {
    for (let i = b.messages.length - 1; i >= 0; i--) {
      const msg = b.messages[i] as { role?: unknown; content?: unknown };
      if (msg?.role !== 'user') continue;
      if (typeof msg.content === 'string') text = msg.content;
      else if (Array.isArray(msg.content)) {
        text = msg.content
          .map((c) => (typeof (c as { text?: unknown })?.text === 'string' ? (c as { text: string }).text : ''))
          .filter(Boolean)
          .join(' ');
      }
      break;
    }
  } else if (typeof b.input === 'string') text = b.input;
  else if (Array.isArray(b.input)) text = b.input.filter((x) => typeof x === 'string').join(' ');
  else if (typeof b.prompt === 'string') text = b.prompt;
  if (!text) return null;
  const t = text.trim();
  return t ? t.slice(0, 200) : null;
}

/** UTC start-of-day for the daily budget window. */
export function startOfUtcDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** True when today's estimated spend has reached the daily budget. */
export function budgetExhausted(spentMicros: number | bigint, dailyBudgetMicros: number | null): boolean {
  if (dailyBudgetMicros === null) return false;
  return Number(spentMicros) >= dailyBudgetMicros;
}

/** The virtual key a request presents, from any header a stock SDK uses. */
export function presentedKey(h: (name: string) => string | undefined): string | null {
  const direct = h('x-swarmy-ai-key')?.trim();
  if (direct) return direct;
  const auth = h('authorization')?.trim();
  if (auth && /^bearer\s+/i.test(auth)) {
    const v = auth.replace(/^bearer\s+/i, '').trim();
    if (v) return v;
  }
  const x = h('x-api-key')?.trim() || h('api-key')?.trim();
  return x || null;
}

/** Effective prompt cap: the tighter of the org guardrail and the key's own. */
export function promptCap(doc: Pick<AiConfigDoc, 'settings'>, policy: Pick<AiKeyPolicy, 'maxPromptTokens'>): number | null {
  const caps = [doc.settings.guardrails.maxPromptTokens, policy.maxPromptTokens].filter((n): n is number => n !== null);
  return caps.length ? Math.min(...caps) : null;
}

/** The app (stack) a key belongs to, from its appRef (`stack` or `stack/service`). */
export function appOfKey(appRef: string | null): string | null {
  if (!appRef) return null;
  return appRef.split('/')[0] || null;
}

export interface GatewayConfig {
  doc: AiConfigDoc;
  keys: Partial<Record<AiProviderKind, string>>;
  /** Hostnames of the org's discovered in-cluster engines (SSRF allowlist). */
  allowHosts?: string[];
}

/** Column pair → parsed doc + decrypted credential map (undecryptable = none). */
export function parseGatewayConfig(providersJson: unknown, configEnc: string | null): GatewayConfig {
  const doc = parseConfigDoc(providersJson);
  const keys: Partial<Record<AiProviderKind, string>> = {};
  if (configEnc) {
    try {
      const parsed = JSON.parse(decryptSecret(configEnc)) as Record<string, unknown>;
      for (const kind of AI_PROVIDER_KINDS) {
        if (typeof parsed[kind] === 'string' && parsed[kind]) keys[kind] = parsed[kind] as string;
      }
    } catch {
      // Undecryptable creds: behave as "no key stored".
    }
  }
  return { doc, keys };
}

// ── Engine state ─────────────────────────────────────────────────────────────

const BODY_MAX_BYTES = 10 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 600_000;
const ABAC_TTL_MS = 30_000;

const rpmWindow = new RpmWindow();
const responseCache = new TtlLruCache<CachedResponse>(100, 5 * 60_000);
const health = new TargetHealth();
const exporter = new SpanExporter();
const abacCache = new TtlLruCache<boolean>(2000, ABAC_TTL_MS);
let retryOptions: RetryOptions = DEFAULT_RETRY;

/** Test seam: shorten backoff. */
export function setRetryOptions(o: RetryOptions): void {
  retryOptions = o;
}

type Op = 'chat' | 'embeddings' | 'messages';

interface KeyRow {
  id: string;
  orgId: string;
  name: string;
  appRef: string | null;
  disabled: boolean;
  limitsJson: unknown;
}

class GatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string = 'swarmy_gateway_error',
  ) {
    super(message);
  }
}

function errorBody(op: Op, status: number, message: string, code: string): Record<string, unknown> {
  if (op === 'messages') {
    const type = status === 401 ? 'authentication_error' : status === 403 ? 'permission_error' : status === 429 ? 'rate_limit_error' : status === 413 ? 'request_too_large' : status >= 500 ? 'api_error' : 'invalid_request_error';
    return { type: 'error', error: { type, message } };
  }
  return { error: { type: 'swarmy_gateway_error', code, message } };
}

function errResponse(op: Op, status: number, message: string, code = 'swarmy_gateway_error', extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(errorBody(op, status, message, code)), {
    status,
    headers: { 'content-type': 'application/json', ...extra },
  });
}

async function loadKey(presented: string): Promise<KeyRow> {
  const row = await prisma.aiVirtualKey.findUnique({
    where: { keyHash: createHash('sha256').update(presented).digest('hex') },
  });
  if (!row) throw new GatewayError(401, 'unknown key');
  if (row.disabled) throw new GatewayError(403, 'key disabled');
  return row;
}

async function loadConfig(orgId: string): Promise<GatewayConfig> {
  const row = await prisma.aiProviderConfig.findUnique({ where: { orgId } });
  const cfg = parseGatewayConfig(row?.providersJson ?? [], row?.configEnc ?? null);
  // Auto-register in-cluster engines (Ollama / vLLM templates) from Docker truth.
  let found: ReturnType<typeof discoverInClusterModels> = [];
  try {
    found = discoverInClusterModels(
      hub.liveInventory(orgId).services.map((s) => ({
        name: s.name,
        image: s.image,
        labels: s.labels,
        stack: s.labels['com.docker.stack.namespace'] ?? null,
      })),
    );
  } catch {
    found = [];
  }
  cfg.doc.providers = withDiscovered(cfg.doc.providers, found);
  cfg.allowHosts = found.map((f) => hostPort(f.baseUrl).address).filter((h): h is string => Boolean(h));
  return cfg;
}

// ── Upstream SSRF guard ──────────────────────────────────────────────────────

const defaultResolver: HostResolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address);
let upstreamResolver: HostResolver = defaultResolver;
let extraAllowHosts: string[] = [];

/** Test seam: the DNS resolver and extra allowed hosts for the upstream guard. */
export function configureUpstreamGuard(o: { resolve?: HostResolver | null; allowHosts?: string[] }): void {
  if (o.resolve !== undefined) upstreamResolver = o.resolve ?? defaultResolver;
  if (o.allowHosts) extraAllowHosts = o.allowHosts;
}

/**
 * Checked right before every upstream fetch: http(s), no userinfo, and the
 * host resolves only to public addresses unless it is one of the org's
 * in-cluster engines. Returns a refusal reason, or null when the URL is fine.
 */
async function upstreamRefusal(url: string, allowHosts: readonly string[] = []): Promise<string | null> {
  const r = await checkProviderUrl(url, { allowQuery: true, resolve: upstreamResolver, allowHosts: [...allowHosts, ...extraAllowHosts] });
  return r.ok ? null : r.reason;
}

/** Upstream fetch that never follows redirects (a 3xx could point anywhere). */
async function upstreamFetch(url: string, init: RequestInit): Promise<Response> {
  const res = await fetch(url, { ...init, redirect: 'manual' });
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`upstream redirect (HTTP ${res.status}) refused`);
  }
  return res;
}

/** ABAC `ai.use` for the member behind the key (cached 30s). */
async function mayUse(orgId: string, userId: string, resolved: ResolvedModel): Promise<boolean> {
  const cacheKey = `${orgId}\u0000${userId}\u0000${resolved.requested}`;
  const hit = abacCache.get(cacheKey);
  if (hit !== null) return hit;
  let ok = false;
  try {
    ok = await canPrincipal(prisma, orgId, userId, 'ai.use', aiModelResource(orgId, resolved));
  } catch {
    ok = false;
  }
  abacCache.set(cacheKey, ok);
  return ok;
}

async function spentToday(key: KeyRow, policy: AiKeyPolicy): Promise<bigint> {
  const app = appOfKey(key.appRef);
  let keyIds = [key.id];
  if (policy.budgetScope === 'app' && app) {
    const siblings = await prisma.aiVirtualKey.findMany({
      where: { orgId: key.orgId, OR: [{ appRef: app }, { appRef: { startsWith: `${app}/` } }] },
      select: { id: true },
    });
    keyIds = [...new Set([key.id, ...siblings.map((s) => s.id)])];
  }
  const spent = await prisma.aiUsage.aggregate({
    where: { keyId: { in: keyIds }, at: { gte: startOfUtcDay() } },
    _sum: { costMicros: true },
  });
  return spent._sum.costMicros ?? 0n;
}

interface UsageRecord {
  orgId: string;
  keyId: string;
  provider: string;
  model: string;
  alias: string | null;
  inTokens: number;
  outTokens: number;
  latencyMs: number;
  status: string;
  cacheHit: boolean;
  auditOn: boolean;
  promptRedacted: string | null;
  attempts: number;
  traceId: string;
}

/** Write AiUsage (+AiRequestLog when the audit toggle is on). Best-effort. */
async function recordUsage(r: UsageRecord): Promise<number> {
  const kind = (AI_PROVIDER_KINDS as readonly string[]).includes(r.provider) ? (r.provider as AiProviderKind) : null;
  const cost = r.cacheHit ? 0 : costMicros(r.model, r.inTokens, r.outTokens, kind);
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
            alias: r.alias,
            status: r.status,
            latencyMs: r.latencyMs,
            inTokens: r.inTokens,
            outTokens: r.outTokens,
            costMicros: cost,
            cacheHit: r.cacheHit,
            attempts: r.attempts,
            traceId: r.traceId,
          },
        },
      });
    }
  } catch {
    // Metering must never break the proxied request.
  }
  return cost;
}

// ── Upstream call (one attempt) ──────────────────────────────────────────────

interface LiveAttempt {
  target: Target;
  upstream: Upstream;
  res: Response;
  span: SpanRecord;
}

function targetKey(t: AiRouteTarget): string {
  return `${t.provider}/${t.model}`;
}

function toTarget(t: AiRouteTarget, cfg: GatewayConfig): Target {
  const descriptor = cfg.doc.providers.find((p) => p.kind === t.provider) ?? { kind: t.provider, baseUrl: null, isDefault: false };
  return { provider: t.provider, model: t.model, descriptor, apiKey: cfg.keys[t.provider] ?? null };
}

function hostPort(url: string): { address: string | null; port: number | null } {
  try {
    const u = new URL(url);
    return { address: u.hostname, port: u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80 };
  } catch {
    return { address: null, port: null };
  }
}

interface CallCtx {
  op: Op;
  key: KeyRow;
  cfg: GatewayConfig;
  resolved: ResolvedModel;
  trace: TraceContext;
  serverSpanId: string;
  spans: SpanRecord[];
  maxTokens: number | null;
  temperature: number | null;
  topP: number | null;
}

/** Try each target (retries/fallbacks) until one answers 2xx; returns the live response. */
async function callUpstream(
  ctx: CallCtx,
  build: (t: Target) => Upstream[],
): Promise<{ live: LiveAttempt[] | null; failure: { status: number; message: string } | null; attempts: AiGatewayRunOutput['attempts'] }> {
  const ordered = orderTargets(ctx.resolved);
  const app = appOfKey(ctx.key.appRef);
  const chain = await runChain<LiveAttempt[], AiRouteTarget>(
    ordered,
    targetKey,
    async (rt): Promise<AttemptResult<LiveAttempt[]>> => {
      const target = toTarget(rt, ctx.cfg);
      if (AI_PROVIDERS[target.provider].needsKey && !target.apiKey) {
        return { ok: false, status: 401, error: `provider "${target.provider}" has no API key stored` };
      }
      let ups: Upstream[];
      try {
        ups = build(target);
      } catch (e) {
        const status = e instanceof AdapterError ? e.status : 400;
        return { ok: false, status, error: e instanceof Error ? e.message : String(e) };
      }
      const out: LiveAttempt[] = [];
      for (const up of ups) {
        const spanId = newSpanId();
        const { address, port } = hostPort(up.url);
        const span: SpanRecord = {
          traceId: ctx.trace.traceId,
          spanId,
          parentSpanId: ctx.serverSpanId,
          name: `${ctx.op === 'embeddings' ? 'embeddings' : 'chat'} ${target.model}`,
          kind: 'client',
          startMs: Date.now(),
          endMs: Date.now(),
          attributes: {
            ...genAiAttributes({
              operation: ctx.op === 'embeddings' ? 'embeddings' : 'chat',
              provider: otelProviderName(target.provider),
              requestModel: target.model,
              maxTokens: ctx.maxTokens,
              temperature: ctx.temperature,
              topP: ctx.topP,
              serverAddress: address,
              serverPort: port,
            }),
            'swarmy.ai.alias': ctx.resolved.alias ?? undefined,
          },
          error: null,
          resource: { orgId: ctx.key.orgId, stack: app },
        };
        ctx.spans.push(span);
        const refused = await upstreamRefusal(up.url, ctx.cfg.allowHosts);
        if (refused) {
          span.endMs = Date.now();
          span.error = `upstream refused: ${refused}`;
          span.attributes['error.type'] = 'ssrf_refused';
          console.warn(`[ai-gateway] org ${ctx.key.orgId} ${target.provider}: upstream URL refused (${refused})`);
          return { ok: false, status: 400, error: `${target.provider} upstream URL refused: ${refused}` };
        }
        let res: Response;
        try {
          res = await upstreamFetch(up.url, {
            method: 'POST',
            headers: { ...up.headers, traceparent: formatTraceparent(ctx.trace.traceId, spanId, ctx.trace.sampled) },
            body: up.body,
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          });
        } catch (e) {
          span.endMs = Date.now();
          span.error = e instanceof Error ? e.message : String(e);
          span.attributes['error.type'] = 'network';
          return { ok: false, status: null, error: `upstream unreachable: ${span.error}` };
        }
        if (!res.ok) {
          // Upstream error text stays in the server log — never reflected to
          // the caller (it may be an internal host's response body).
          const text = await res.text().catch(() => '');
          if (text) console.warn(`[ai-gateway] org ${ctx.key.orgId} ${target.provider} HTTP ${res.status}: ${text.slice(0, 300)}`);
          span.endMs = Date.now();
          span.error = `HTTP ${res.status}`;
          span.attributes['error.type'] = String(res.status);
          return {
            ok: false,
            status: res.status,
            error: `${target.provider} HTTP ${res.status}`,
            retryAfterMs: parseRetryAfter(res.headers.get('retry-after')) ?? undefined,
          };
        }
        out.push({ target, upstream: up, res, span });
      }
      return { ok: true, value: out };
    },
    retryOptions,
    health,
  );
  const attempts = chain.attempts.map((a) => {
    const [provider, ...rest] = a.target.split('/');
    return { provider: provider ?? '', model: rest.join('/'), status: a.status, error: a.error };
  });
  if (chain.result.ok) return { live: chain.result.value, failure: null, attempts };
  const st = chain.result.status;
  return {
    live: null,
    failure: { status: st === null ? 502 : st === 401 || st === 403 || st === 404 ? 502 : st, message: chain.result.error },
    attempts,
  };
}

// ── The request pipeline ─────────────────────────────────────────────────────

interface Pipeline {
  op: Op;
  path: string;
  presented: string | null;
  /** Playground: key id + the member running it (bypasses the presented key). */
  playground?: { keyId: string; userId: string; orgId: string };
  rawBody: string;
  traceparent: string | null;
}

interface PipelineResult {
  response: Response;
  meta: {
    provider: string | null;
    model: string | null;
    inTokens: number;
    outTokens: number;
    costMicros: number;
    attempts: AiGatewayRunOutput['attempts'];
    traceId: string;
    /** Resolves when a streamed response finished metering. */
    done: Promise<void>;
  };
}

async function authKey(p: Pipeline): Promise<KeyRow> {
  if (p.playground) {
    const row = await prisma.aiVirtualKey.findFirst({ where: { id: p.playground.keyId, orgId: p.playground.orgId } });
    if (!row) throw new GatewayError(404, 'unknown key');
    if (row.disabled) throw new GatewayError(403, 'key disabled');
    return row;
  }
  if (!p.presented) throw new GatewayError(401, 'missing key (x-swarmy-ai-key or Authorization: Bearer)');
  return loadKey(p.presented);
}

async function runPipeline(p: Pipeline): Promise<PipelineResult> {
  const started = Date.now();
  const trace = parseTraceparent(p.traceparent);
  const serverSpanId = newSpanId();
  const spans: SpanRecord[] = [];
  let doneResolve: () => void = () => {};
  const done = new Promise<void>((r) => (doneResolve = r));
  const meta: PipelineResult['meta'] = { provider: null, model: null, inTokens: 0, outTokens: 0, costMicros: 0, attempts: [], traceId: trace.traceId, done };
  const traceHeaders = {
    traceparent: formatTraceparent(trace.traceId, serverSpanId, trace.sampled),
    'x-swarmy-ai-trace-id': trace.traceId,
  };
  const finishSpans = (key: KeyRow | null, status: number, err: string | null): void => {
    spans.push({
      traceId: trace.traceId,
      spanId: serverSpanId,
      parentSpanId: trace.parentSpanId,
      name: `POST /ai${p.path}`,
      kind: 'server',
      startMs: started,
      endMs: Date.now(),
      attributes: {
        'http.request.method': 'POST',
        'http.route': `/ai${p.path}`,
        'http.response.status_code': status,
        'gen_ai.operation.name': p.op === 'embeddings' ? 'embeddings' : 'chat',
        'swarmy.ai.key': key?.name,
        'swarmy.ai.playground': p.playground ? true : undefined,
      },
      error: err,
      resource: { orgId: key?.orgId ?? 'unknown', stack: appOfKey(key?.appRef ?? null) },
    });
    if (key && trace.sampled) exporter.add(spans);
  };
  const fail = (key: KeyRow | null, status: number, message: string, code?: string, extra: Record<string, string> = {}): PipelineResult => {
    finishSpans(key, status, message);
    doneResolve();
    return { response: errResponse(p.op, status, message, code, { ...traceHeaders, ...extra }), meta };
  };

  let key: KeyRow;
  try {
    key = await authKey(p);
  } catch (e) {
    if (e instanceof GatewayError) return fail(null, e.status, e.message);
    throw e;
  }

  if (p.rawBody.length > BODY_MAX_BYTES) return fail(key, 413, 'request body too large');
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(p.rawBody) as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
  } catch {
    return fail(key, 400, 'body must be a JSON object');
  }
  const requested = typeof body.model === 'string' ? body.model.trim() : '';
  if (!requested) return fail(key, 400, 'missing "model"');
  const wantsStream = body.stream === true && p.op !== 'embeddings';

  const cfg = await loadConfig(key.orgId);
  if (cfg.doc.providers.length === 0) return fail(key, 400, 'no AI provider configured for this org');
  const resolved = resolveModel(requested, cfg.doc);
  if (!resolved) return fail(key, 400, `no provider configured for model "${requested}"`, 'model_not_found');

  // ── policy ──
  const policy = parseKeyPolicy(key.limitsJson);
  const app = appOfKey(key.appRef);
  if (!modelAllowed(resolved, [policy.models, app ? cfg.doc.apps[app]?.models : null])) {
    return fail(key, 403, `model "${requested}" is not allowed for this key`, 'model_not_allowed');
  }
  const principal = p.playground?.userId ?? policy.mintedBy;
  if (principal && !(await mayUse(key.orgId, principal, resolved))) {
    return fail(key, 403, `policy denies ai.use on "${requested}"`, 'policy_denied');
  }
  const cap = promptCap(cfg.doc, policy);
  const promptTokens = estimatePromptTokens(body);
  if (cap !== null && promptTokens > cap) {
    return fail(key, 413, `prompt is ~${promptTokens} tokens; the limit is ${cap}`, 'prompt_too_large');
  }
  if (policy.rpm !== null && !rpmWindow.allow(key.id, policy.rpm)) {
    return fail(key, 429, `rate limit exceeded (${policy.rpm} requests/minute)`, 'rate_limited', { 'retry-after': '60' });
  }
  if (policy.dailyBudgetMicros !== null && budgetExhausted(await spentToday(key, policy), policy.dailyBudgetMicros)) {
    return fail(key, 429, policy.budgetScope === 'app' ? "daily budget exhausted for this key's app" : 'daily budget exhausted for this key', 'budget_exhausted');
  }

  const auditOn = cfg.doc.settings.auditLog;
  const rawPrompt = auditOn ? redactPrompt(body) : null;
  const promptRedacted = rawPrompt && cfg.doc.settings.guardrails.redactPii ? redactPii(rawPrompt) : rawPrompt;
  const usageBase = { orgId: key.orgId, keyId: key.id, alias: resolved.alias, auditOn, promptRedacted, traceId: trace.traceId };

  // ── cache (exact body, non-streaming, org+path scoped) ──
  const cacheKey = createHash('sha256').update(`${key.orgId}\n${p.path}\n${p.rawBody}`).digest('hex');
  if (cfg.doc.settings.cache && !wantsStream) {
    const hit = responseCache.get(cacheKey);
    if (hit) {
      Object.assign(meta, { provider: hit.provider, model: hit.model, inTokens: hit.inTokens, outTokens: hit.outTokens });
      await recordUsage({ ...usageBase, provider: hit.provider, model: hit.model, inTokens: hit.inTokens, outTokens: hit.outTokens, latencyMs: Date.now() - started, status: 'ok', cacheHit: true, attempts: 0 });
      finishSpans(key, hit.status, null);
      doneResolve();
      return {
        response: new Response(hit.body, { status: hit.status, headers: { 'content-type': hit.contentType, 'x-swarmy-ai-cache': 'hit', 'x-swarmy-ai-provider': hit.provider, 'x-swarmy-ai-model': hit.model, ...traceHeaders } }),
        meta,
      };
    }
  }

  const ctx: CallCtx = {
    op: p.op,
    key,
    cfg,
    resolved,
    trace,
    serverSpanId,
    spans,
    maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : typeof body.max_completion_tokens === 'number' ? (body.max_completion_tokens as number) : null,
    temperature: typeof body.temperature === 'number' ? body.temperature : null,
    topP: typeof body.top_p === 'number' ? body.top_p : null,
  };

  // Per target: how to build the upstream call(s) for this op.
  const nativeAnthropic = (t: Target): boolean => p.op === 'messages' && t.provider === 'anthropic';
  const build = (t: Target): Upstream[] => {
    if (p.op === 'embeddings') return buildEmbed(t, { ...(body as unknown as EmbeddingRequest), model: t.model });
    if (nativeAnthropic(t)) {
      const base = (t.descriptor.baseUrl ?? AI_PROVIDERS.anthropic.defaultBaseUrl)!.replace(/\/+$/, '');
      return [
        {
          url: `${base}/v1/messages`,
          headers: {
            'content-type': 'application/json',
            'anthropic-version': '2023-06-01',
            ...(t.apiKey ? { 'x-api-key': t.apiKey } : {}),
          },
          body: JSON.stringify({ ...body, model: t.model }),
          framing: wantsStream ? 'sse' : 'json',
        },
      ];
    }
    const chatReq: ChatRequest = p.op === 'messages' ? anthropicToOpenAIRequest(body, t.model) : ({ ...(body as unknown as ChatRequest), model: t.model });
    if (p.op === 'messages' && chatReq.max_tokens === undefined) chatReq.max_tokens = ANTHROPIC_DEFAULT_MAX_TOKENS;
    return [buildChat(t, chatReq)];
  };

  const call = await callUpstream(ctx, build);
  meta.attempts = call.attempts;
  const attemptsHeader = { 'x-swarmy-ai-attempts': String(call.attempts.length) };
  if (!call.live) {
    const lastTarget = call.attempts[call.attempts.length - 1];
    await recordUsage({ ...usageBase, provider: lastTarget?.provider ?? 'unknown', model: lastTarget?.model || requested, inTokens: 0, outTokens: 0, latencyMs: Date.now() - started, status: `error:${call.failure!.status}`, cacheHit: false, attempts: call.attempts.length });
    return fail(key, call.failure!.status, call.failure!.message, 'upstream_error', attemptsHeader);
  }

  const live = call.live;
  const first = live[0]!;
  const target = first.target;
  meta.provider = target.provider;
  meta.model = target.model;
  const respHeaders = {
    ...traceHeaders,
    ...attemptsHeader,
    'x-swarmy-ai-provider': target.provider,
    'x-swarmy-ai-model': target.model,
    ...(resolved.alias ? { 'x-swarmy-ai-alias': resolved.alias } : {}),
  };
  const meter = async (inTokens: number, outTokens: number, status: string, extra: { responseModel?: string | null; responseId?: string | null; finish?: string | null; error?: string | null } = {}): Promise<void> => {
    for (const l of live) {
      l.span.endMs = Date.now();
      Object.assign(
        l.span.attributes,
        genAiAttributes({
          operation: p.op === 'embeddings' ? 'embeddings' : 'chat',
          provider: otelProviderName(target.provider),
          requestModel: target.model,
          responseModel: extra.responseModel ?? undefined,
          responseId: extra.responseId ?? undefined,
          finishReasons: extra.finish ? [extra.finish] : undefined,
          inTokens,
          outTokens,
          maxTokens: ctx.maxTokens,
          temperature: ctx.temperature,
          topP: ctx.topP,
          serverAddress: l.span.attributes['server.address'] as string,
          serverPort: l.span.attributes['server.port'] as number,
          errorType: extra.error ? 'stream_error' : undefined,
        }),
      );
      if (extra.error) l.span.error = extra.error;
    }
    const cost = await recordUsage({ ...usageBase, provider: target.provider, model: target.model, inTokens, outTokens, latencyMs: Date.now() - started, status, cacheHit: false, attempts: call.attempts.length });
    for (const l of live) l.span.attributes['swarmy.ai.cost_usd'] = cost / 1e6;
    Object.assign(meta, { inTokens, outTokens, costMicros: cost });
    finishSpans(key, 200, extra.error ?? null);
    doneResolve();
  };

  // ── embeddings ──
  if (p.op === 'embeddings') {
    const jsons: unknown[] = [];
    for (const l of live) jsons.push(await l.res.json().catch(() => null));
    const out = parseEmbed(target, jsons, promptTokens);
    await meter(out.usage.prompt_tokens, 0, 'ok', { responseModel: out.model });
    const text = JSON.stringify(out);
    if (cfg.doc.settings.cache) responseCache.set(cacheKey, { status: 200, contentType: 'application/json', body: text, inTokens: out.usage.prompt_tokens, outTokens: 0, provider: target.provider, model: target.model });
    return { response: new Response(text, { status: 200, headers: { 'content-type': 'application/json', ...respHeaders } }), meta };
  }

  // ── non-streaming chat / messages ──
  if (!wantsStream) {
    const text = await first.res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    let outText: string;
    let inTokens: number;
    let outTokens: number;
    let responseModel: string | null = null;
    let finish: string | null = null;
    if (nativeAnthropic(target)) {
      const u = (json as { usage?: Parameters<typeof anthropicInputTokens>[0] } | null)?.usage;
      inTokens = u ? anthropicInputTokens(u) : promptTokens;
      outTokens = u?.output_tokens ?? 0;
      responseModel = (json as { model?: string } | null)?.model ?? null;
      finish = (json as { stop_reason?: string } | null)?.stop_reason ?? null;
      outText = text;
    } else {
      const r = parseChat(target, json);
      inTokens = r.usage.prompt_tokens || promptTokens;
      outTokens = r.usage.completion_tokens;
      responseModel = r.model;
      finish = r.choices[0]?.finish_reason ?? null;
      outText = JSON.stringify(p.op === 'messages' ? openAIToAnthropicResponse(r, requested) : r);
    }
    await meter(inTokens, outTokens, 'ok', { responseModel, finish });
    if (cfg.doc.settings.cache) responseCache.set(cacheKey, { status: 200, contentType: 'application/json', body: outText, inTokens, outTokens, provider: target.provider, model: target.model });
    return { response: new Response(outText, { status: 200, headers: { 'content-type': 'application/json', ...respHeaders } }), meta };
  }

  // ── streaming ──
  const upstreamBody = first.res.body as unknown as ReadableStream<Uint8Array> | null;
  if (!upstreamBody) {
    await meter(0, 0, 'error:empty-stream', { error: 'empty upstream stream' });
    return fail(key, 502, 'upstream returned an empty stream');
  }
  const wantUsage = p.op === 'chat' && (body.stream_options as { include_usage?: boolean } | undefined)?.include_usage === true;
  const framing = first.upstream.framing;
  const translator: StreamTranslator | null = nativeAnthropic(target) ? null : chatStream(target, p.op === 'messages' ? true : wantUsage);
  const anthUsage = nativeAnthropic(target) ? new AnthropicToOpenAIStream(target.model) : null;
  const toAnthropic = p.op === 'messages' && !nativeAnthropic(target) ? new OpenAIToAnthropicStream(requested) : null;
  const sse = framing === 'aws' ? null : new SseDecoder();
  const aws = framing === 'aws' ? new AwsEventStreamDecoder() : null;
  const enc = new TextEncoder();
  let streamError: string | null = null;

  const emitChunks = (chunks: ChatChunk[], ctl: TransformStreamDefaultController<Uint8Array>): void => {
    for (const c of chunks) {
      if (toAnthropic) for (const ev of toAnthropic.feed(c)) ctl.enqueue(encodeSse(JSON.stringify(ev.data), ev.event));
      else ctl.enqueue(encodeSse(JSON.stringify(c)));
    }
  };
  const frames = (bytes: Uint8Array | null): Array<{ event: string | null; data: string }> => {
    if (aws) {
      if (!bytes) return [];
      return aws.push(bytes).map((ev) => ({
        event: ev.headers[':message-type'] === 'exception' ? (ev.headers[':exception-type'] ?? 'exception') : (ev.headers[':event-type'] ?? null),
        data: new TextDecoder().decode(ev.payload),
      }));
    }
    return bytes ? sse!.push(bytes) : sse!.end();
  };
  const handle = (fs: Array<{ event: string | null; data: string }>, ctl: TransformStreamDefaultController<Uint8Array>): void => {
    for (const f of fs) {
      if (anthUsage) {
        anthUsage.feed(f.event, f.data);
        ctl.enqueue(encodeSse(f.data, f.event));
        if (f.event === 'error') streamError = f.data.slice(0, 300);
        continue;
      }
      emitChunks(translator!.feed(f), ctl);
    }
  };

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(bytes, ctl) {
      try {
        handle(frames(bytes), ctl);
      } catch (e) {
        streamError = e instanceof Error ? e.message : String(e);
      }
    },
    async flush(ctl) {
      try {
        handle(frames(null), ctl);
      } catch (e) {
        streamError = e instanceof Error ? e.message : String(e);
      }
      if (translator) {
        emitChunks(translator.end(), ctl);
        streamError ??= translator.error;
        if (translator.error && !toAnthropic) ctl.enqueue(encodeSse(JSON.stringify({ error: { type: 'upstream_error', message: translator.error } })));
      }
      if (toAnthropic) {
        if (translator) {
          toAnthropic.inTokens = translator.inTokens;
          toAnthropic.outTokens = translator.outTokens;
        }
        for (const ev of toAnthropic.end()) ctl.enqueue(encodeSse(JSON.stringify(ev.data), ev.event));
      } else if (!anthUsage) {
        ctl.enqueue(enc.encode('data: [DONE]\n\n'));
      }
      const inTokens = (translator?.inTokens ?? anthUsage?.inTokens ?? 0) || promptTokens;
      const outTokens = translator?.outTokens ?? anthUsage?.outTokens ?? 0;
      await meter(inTokens, outTokens, streamError ? 'error:stream' : 'ok', {
        responseModel: translator?.responseModel ?? anthUsage?.responseModel ?? null,
        responseId: translator?.responseId ?? anthUsage?.id ?? null,
        finish: translator?.finish ?? anthUsage?.finish ?? null,
        error: streamError,
      });
    },
  });
  const piped = upstreamBody.pipeThrough(transform);
  return {
    response: new Response(piped as unknown as ConstructorParameters<typeof Response>[0], {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', ...respHeaders },
    }),
    meta,
  };
}

// ── Hono app ─────────────────────────────────────────────────────────────────

function opFor(path: string): Op | null {
  if (path.endsWith('/v1/chat/completions')) return 'chat';
  if (path.endsWith('/v1/embeddings')) return 'embeddings';
  if (path.endsWith('/v1/messages')) return 'messages';
  return null;
}

async function proxy(c: Context): Promise<Response> {
  const path = c.req.path.replace(/^\/ai/, '');
  const op = opFor(path)!;
  // The body cap (chunked included) is enforced by bodyLimit on the app.
  const rawBody = await c.req.text();
  const r = await runPipeline({
    op,
    path,
    presented: presentedKey((n) => c.req.header(n)),
    rawBody,
    traceparent: c.req.header('traceparent') ?? null,
  });
  return r.response;
}

/** `GET /ai/v1/models` — the names this key may call (OpenAI list shape). */
async function listModels(c: Context): Promise<Response> {
  const presented = presentedKey((n) => c.req.header(n));
  if (!presented) return errResponse('chat', 401, 'missing key');
  let key: KeyRow;
  try {
    key = await loadKey(presented);
  } catch (e) {
    if (e instanceof GatewayError) return errResponse('chat', e.status, e.message);
    throw e;
  }
  const cfg = await loadConfig(key.orgId);
  const policy = parseKeyPolicy(key.limitsJson);
  const app = appOfKey(key.appRef);
  const configured = cfg.doc.providers.map((p) => p.kind);
  const names = new Map<string, string>();
  for (const [name, r] of Object.entries(effectiveRoutes(cfg.doc, configured))) names.set(name, r.targets[0]?.provider ?? 'swarmy');
  for (const row of MODEL_CATALOG) if (configured.includes(row.provider)) names.set(row.id, row.provider);
  const data = [...names.entries()]
    .filter(([name]) => {
      const res = resolveModel(name, cfg.doc);
      return res !== null && modelAllowed(res, [policy.models, app ? cfg.doc.apps[app]?.models : null]);
    })
    .map(([id, owner]) => ({ id, object: 'model', created: 0, owned_by: owner }));
  return c.json({ object: 'list', data });
}

export const aiGatewayApp = new Hono();

// Before auth and before any handler reads: bodyLimit counts chunked bodies
// too (no Content-Length), so a stream can't bypass the cap.
aiGatewayApp.use(
  '*',
  bodyLimit({
    maxSize: BODY_MAX_BYTES,
    onError: (c) => errResponse(opFor(c.req.path) ?? 'chat', 413, 'request body too large'),
  }),
);

aiGatewayApp.post('/v1/chat/completions', proxy);
aiGatewayApp.post('/v1/embeddings', proxy);
aiGatewayApp.post('/v1/messages', proxy);
aiGatewayApp.get('/v1/models', listModels);
aiGatewayApp.all('/v1/*', (c) =>
  c.json({ error: { type: 'swarmy_gateway_error', message: 'unsupported endpoint' } }, 404),
);

// ── In-process runner for the dashboard playground ───────────────────────────

export async function runGatewayInProcess(input: AiGatewayRunInput): Promise<AiGatewayRunOutput> {
  const started = Date.now();
  const r = await runPipeline({
    op: input.path === '/v1/embeddings' ? 'embeddings' : 'chat',
    path: input.path,
    presented: null,
    playground: { keyId: input.keyId, userId: input.userId, orgId: input.orgId },
    rawBody: JSON.stringify({ ...input.body, stream: false }),
    traceparent: null,
  });
  const json = await r.response.json().catch(() => null);
  await r.meta.done;
  return {
    status: r.response.status,
    json,
    provider: r.meta.provider,
    model: r.meta.model,
    inTokens: r.meta.inTokens,
    outTokens: r.meta.outTokens,
    costMicros: r.meta.costMicros,
    latencyMs: Date.now() - started,
    attempts: r.meta.attempts,
    traceId: r.meta.traceId,
  };
}

registerAiGatewayRunner(runGatewayInProcess);

// ── Provider probe (the "Test" button) ───────────────────────────────────────

/**
 * One cheap check per provider with the stored credential: a free model list
 * where the provider has one that validates the key, else a 1-token chat on
 * the cheapest catalogue model. Never metered.
 */
export async function probeProvider(orgId: string, provider: AiProviderKind): Promise<{ ok: boolean; latencyMs: number; target: string; message: string | null }> {
  const started = Date.now();
  const cfg = await loadConfig(orgId);
  const descriptor = cfg.doc.providers.find((p) => p.kind === provider);
  if (!descriptor) return { ok: false, latencyMs: 0, target: provider, message: `provider "${provider}" is not configured` };
  const t: Target = { provider, model: probeModel(provider) ?? '', descriptor, apiKey: cfg.keys[provider] ?? null };
  if (AI_PROVIDERS[provider].needsKey && !t.apiKey) return { ok: false, latencyMs: 0, target: provider, message: 'no API key stored — save one first' };
  let url: string;
  let init: RequestInit;
  try {
    const base = baseUrlOf(t);
    const bearerH: Record<string, string> = t.apiKey ? { authorization: `Bearer ${t.apiKey}` } : {};
    switch (provider) {
      case 'openai':
      case 'mistral':
      case 'groq':
      case 'ollama':
      case 'vllm':
      case 'custom':
        url = `${base}/v1/models`;
        init = { headers: bearerH };
        break;
      case 'openrouter':
        url = `${base}/v1/key`;
        init = { headers: bearerH };
        break;
      case 'azure':
        url = `${base}/openai/models?api-version=${encodeURIComponent(descriptor.apiVersion ?? AZURE_DEFAULT_API_VERSION)}`;
        init = { headers: t.apiKey ? { 'api-key': t.apiKey } : {} };
        break;
      case 'gemini':
        url = `${base}/v1beta/models?pageSize=1`;
        init = { headers: t.apiKey ? { 'x-goog-api-key': t.apiKey } : {} };
        break;
      default: {
        const up = buildChat(t, { model: t.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] });
        url = up.url;
        init = { method: 'POST', headers: up.headers, body: up.body };
      }
    }
  } catch (e) {
    return { ok: false, latencyMs: 0, target: provider, message: e instanceof Error ? e.message : String(e) };
  }
  const target = t.model && !url.includes('/models') && !url.endsWith('/key') ? t.model : url;
  const refused = await upstreamRefusal(url, cfg.allowHosts);
  if (refused) return { ok: false, latencyMs: 0, target, message: `upstream URL refused: ${refused}` };
  try {
    const res = await upstreamFetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    const latencyMs = Date.now() - started;
    if (res.ok) {
      await res.body?.cancel().catch(() => {});
      return { ok: true, latencyMs, target, message: null };
    }
    const text = await res.text().catch(() => '');
    if (text) console.warn(`[ai-gateway] probe org ${orgId} ${provider} HTTP ${res.status}: ${text.slice(0, 300)}`);
    return { ok: false, latencyMs, target, message: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - started, target, message: e instanceof Error ? e.message : String(e) };
  }
}

registerAiProviderProbe(probeProvider);
