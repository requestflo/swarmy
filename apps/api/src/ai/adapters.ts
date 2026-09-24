/**
 * Provider adapters: how one resolved target (provider + model + creds) is
 * called for a canonical (OpenAI-shaped) chat or embeddings request, and how
 * its answer is turned back into the canonical shape. Pure except for the
 * SigV4 clock — every function here has a golden test in adapters.test.ts.
 */
import { AI_PROVIDERS, type AiProviderDescriptor, type AiProviderKind } from '@swarmy/core/views';
import { fromAnthropicResponse, toAnthropicRequest, AnthropicToOpenAIStream } from './anthropic';
import { bedrockUrl, fromBedrockResponse, fromTitanEmbed, toBedrockRequest, toTitanEmbedBody, BedrockToOpenAIStream } from './bedrock';
import { fromGeminiEmbedResponse, fromGeminiResponse, toGeminiEmbedRequest, toGeminiRequest, GeminiToOpenAIStream } from './gemini';
import { parseAwsCredential, signV4 } from './sigv4';
import {
  genId,
  nowSec,
  usageOf,
  type ChatChunk,
  type ChatRequest,
  type ChatResponse,
  type EmbeddingRequest,
  type EmbeddingResponse,
  type FinishReason,
} from './wire';

export const ANTHROPIC_VERSION = '2023-06-01';
export const AZURE_DEFAULT_API_VERSION = '2024-10-21';
export const BEDROCK_DEFAULT_REGION = 'us-east-1';

export interface Target {
  provider: AiProviderKind;
  model: string;
  descriptor: AiProviderDescriptor;
  apiKey: string | null;
}

export interface Upstream {
  url: string;
  headers: Record<string, string>;
  body: string;
  /** How the (streamed) response is framed. */
  framing: 'sse' | 'aws' | 'json';
}

export class AdapterError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 501 = 400,
  ) {
    super(message);
  }
}

/** The API root for a target (descriptor override → provider default). */
export function baseUrlOf(t: Pick<Target, 'provider' | 'descriptor'>): string {
  const raw = t.descriptor.baseUrl ?? AI_PROVIDERS[t.provider].defaultBaseUrl;
  if (!raw) throw new AdapterError(`provider "${t.provider}" has no base URL`);
  // OpenAI-compatible roots are often pasted with a trailing /v1 — we add it.
  return raw.replace(/\/+$/, '').replace(/\/v1$/, '');
}

function bearer(t: Target): Record<string, string> {
  return t.apiKey ? { authorization: `Bearer ${t.apiKey}` } : {};
}

function openAIHeaders(t: Target): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (t.provider === 'azure') {
    if (t.apiKey) h['api-key'] = t.apiKey;
    return h;
  }
  Object.assign(h, bearer(t));
  if (t.provider === 'openrouter') {
    h['http-referer'] = 'https://swarmy.dev';
    h['x-title'] = 'swarmy';
  }
  return h;
}

function openAIUrl(t: Target, op: 'chat/completions' | 'embeddings'): string {
  const base = baseUrlOf(t);
  if (t.provider === 'azure') {
    const dep = t.descriptor.deployments?.[t.model] ?? t.model;
    const v = t.descriptor.apiVersion ?? AZURE_DEFAULT_API_VERSION;
    return `${base}/openai/deployments/${encodeURIComponent(dep)}/${op}?api-version=${encodeURIComponent(v)}`;
  }
  return `${base}/v1/${op}`;
}

function bedrockSign(t: Target, url: string, body: string, accept: string, now?: Date): Record<string, string> {
  if (!t.apiKey) throw new AdapterError('bedrock has no credentials stored');
  const cred = parseAwsCredential(t.apiKey);
  const base = { 'content-type': 'application/json', accept };
  if (cred.kind === 'bearer') return { ...base, authorization: `Bearer ${cred.token}` };
  return signV4({
    method: 'POST',
    url,
    headers: base,
    body,
    region: t.descriptor.region ?? BEDROCK_DEFAULT_REGION,
    service: 'bedrock',
    creds: cred.creds,
    now,
  });
}

/** Providers that accept `stream_options.include_usage` on OpenAI-shaped streams. */
const INCLUDE_USAGE = new Set<AiProviderKind>(['openai', 'azure', 'groq', 'openrouter', 'ollama', 'vllm', 'custom']);

// ── chat ─────────────────────────────────────────────────────────────────────

export function buildChat(t: Target, req: ChatRequest, now?: Date): Upstream {
  const stream = req.stream === true;
  const wire = AI_PROVIDERS[t.provider].wire;
  if (wire === 'anthropic') {
    const body = JSON.stringify(toAnthropicRequest(req, t.model));
    return {
      url: `${baseUrlOf(t)}/v1/messages`,
      headers: { 'content-type': 'application/json', 'anthropic-version': ANTHROPIC_VERSION, ...(t.apiKey ? { 'x-api-key': t.apiKey } : {}) },
      body,
      framing: stream ? 'sse' : 'json',
    };
  }
  if (wire === 'gemini') {
    const op = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    const model = t.model.replace(/^models\//, '');
    return {
      url: `${baseUrlOf(t)}/v1beta/models/${encodeURIComponent(model)}:${op}`,
      headers: { 'content-type': 'application/json', ...(t.apiKey ? { 'x-goog-api-key': t.apiKey } : {}) },
      body: JSON.stringify(toGeminiRequest(req)),
      framing: stream ? 'sse' : 'json',
    };
  }
  if (wire === 'bedrock') {
    const region = t.descriptor.region ?? BEDROCK_DEFAULT_REGION;
    const url = bedrockUrl(region, t.model, stream ? 'converse-stream' : 'converse');
    const body = JSON.stringify(toBedrockRequest(req));
    return { url, headers: bedrockSign(t, url, body, stream ? 'application/vnd.amazon.eventstream' : 'application/json', now), body, framing: stream ? 'aws' : 'json' };
  }
  // OpenAI-shaped: pass the request through with the target model.
  const out: ChatRequest = { ...req, model: t.model };
  if (t.provider === 'azure') delete (out as { model?: string }).model;
  if (stream && INCLUDE_USAGE.has(t.provider)) out.stream_options = { ...(req.stream_options ?? {}), include_usage: true };
  return { url: openAIUrl(t, 'chat/completions'), headers: openAIHeaders(t), body: JSON.stringify(out), framing: stream ? 'sse' : 'json' };
}

export function parseChat(t: Target, json: unknown): ChatResponse {
  const wire = AI_PROVIDERS[t.provider].wire;
  if (wire === 'anthropic') return fromAnthropicResponse(json, t.model);
  if (wire === 'gemini') return fromGeminiResponse(json, t.model);
  if (wire === 'bedrock') return fromBedrockResponse(json, t.model);
  const r = (json ?? {}) as Partial<ChatResponse>;
  const u = (r.usage ?? {}) as Partial<ChatResponse['usage']>;
  return {
    ...(r as ChatResponse),
    id: r.id ?? genId('chatcmpl-'),
    object: 'chat.completion',
    created: r.created ?? nowSec(),
    model: r.model ?? t.model,
    choices: r.choices ?? [],
    usage: usageOf(u.prompt_tokens ?? 0, u.completion_tokens ?? 0),
  };
}

/** One upstream stream frame, already de-framed (SSE event or AWS event). */
export interface Frame {
  event: string | null;
  data: string;
}

export interface StreamTranslator {
  feed(frame: Frame): ChatChunk[];
  /** Chunks to append when the upstream stream ends (usage chunk when asked). */
  end(): ChatChunk[];
  readonly inTokens: number;
  readonly outTokens: number;
  readonly finish: FinishReason;
  readonly responseModel: string | null;
  readonly responseId: string | null;
  /** A mid-stream provider error, when one arrived. */
  readonly error: string | null;
}

/** OpenAI-shaped streams: forward chunks, keep the usage, hide an injected usage chunk. */
class OpenAIPassthrough implements StreamTranslator {
  inTokens = 0;
  outTokens = 0;
  finish: FinishReason = null;
  responseModel: string | null = null;
  responseId: string | null = null;
  error: string | null = null;
  constructor(private readonly wantUsage: boolean) {}
  feed(f: Frame): ChatChunk[] {
    if (!f.data || f.data === '[DONE]') return [];
    let c: ChatChunk & { error?: { message?: string } };
    try {
      c = JSON.parse(f.data) as ChatChunk & { error?: { message?: string } };
    } catch {
      return [];
    }
    if (c.error) {
      this.error = c.error.message ?? 'upstream stream error';
      return [];
    }
    if (c.model) this.responseModel = c.model;
    if (c.id) this.responseId = c.id;
    if (c.usage) {
      this.inTokens = c.usage.prompt_tokens ?? this.inTokens;
      this.outTokens = c.usage.completion_tokens ?? this.outTokens;
    }
    const fin = c.choices?.find((ch) => ch.finish_reason)?.finish_reason;
    if (fin) this.finish = fin;
    if ((!c.choices || c.choices.length === 0) && c.usage && !this.wantUsage) return [];
    if (c.usage && !this.wantUsage) delete c.usage;
    return [c];
  }
  end(): ChatChunk[] {
    return [];
  }
}

/** Wrap an adapter-specific translator into the common interface. */
class Wrapped implements StreamTranslator {
  constructor(
    private readonly inner: {
      feed(event: string | null, data: string): ChatChunk[];
      usage(): ChatChunk;
      inTokens: number;
      outTokens: number;
      finish: FinishReason;
      id: string;
      responseModel?: string | null;
      error?: string | null;
    },
    private readonly wantUsage: boolean,
  ) {}
  feed(f: Frame): ChatChunk[] {
    return this.inner.feed(f.event, f.data);
  }
  end(): ChatChunk[] {
    return this.wantUsage ? [this.inner.usage()] : [];
  }
  get inTokens(): number {
    return this.inner.inTokens;
  }
  get outTokens(): number {
    return this.inner.outTokens;
  }
  get finish(): FinishReason {
    return this.inner.finish;
  }
  get responseModel(): string | null {
    return this.inner.responseModel ?? null;
  }
  get responseId(): string | null {
    return this.inner.id;
  }
  get error(): string | null {
    return this.inner.error ?? null;
  }
}

export function chatStream(t: Target, wantUsage: boolean): StreamTranslator {
  const wire = AI_PROVIDERS[t.provider].wire;
  if (wire === 'anthropic') return new Wrapped(new AnthropicToOpenAIStream(t.model), wantUsage);
  if (wire === 'gemini') return new Wrapped(new GeminiToOpenAIStream(t.model), wantUsage);
  if (wire === 'bedrock') return new Wrapped(new BedrockToOpenAIStream(t.model), wantUsage);
  return new OpenAIPassthrough(wantUsage);
}

// ── embeddings ───────────────────────────────────────────────────────────────

export function buildEmbed(t: Target, req: EmbeddingRequest, estimatedTokens = 0, now?: Date): Upstream[] {
  void estimatedTokens;
  const wire = AI_PROVIDERS[t.provider].wire;
  if (wire === 'anthropic') throw new AdapterError('Anthropic has no embeddings API — route `embed` to another provider', 400);
  if (wire === 'gemini') {
    const model = t.model.replace(/^models\//, '');
    return [
      {
        url: `${baseUrlOf(t)}/v1beta/models/${encodeURIComponent(model)}:batchEmbedContents`,
        headers: { 'content-type': 'application/json', ...(t.apiKey ? { 'x-goog-api-key': t.apiKey } : {}) },
        body: JSON.stringify(toGeminiEmbedRequest(req, model)),
        framing: 'json',
      },
    ];
  }
  if (wire === 'bedrock') {
    const region = t.descriptor.region ?? BEDROCK_DEFAULT_REGION;
    const url = bedrockUrl(region, t.model, 'invoke');
    const inputs = Array.isArray(req.input) ? req.input : [req.input];
    return inputs.map((text) => {
      const body = JSON.stringify(toTitanEmbedBody(text, req.dimensions));
      return { url, headers: bedrockSign(t, url, body, 'application/json', now), body, framing: 'json' as const };
    });
  }
  const out: EmbeddingRequest = { ...req, model: t.model };
  if (t.provider === 'azure') delete (out as { model?: string }).model;
  return [{ url: openAIUrl(t, 'embeddings'), headers: openAIHeaders(t), body: JSON.stringify(out), framing: 'json' }];
}

export function parseEmbed(t: Target, jsons: unknown[], estimatedTokens: number): EmbeddingResponse {
  const wire = AI_PROVIDERS[t.provider].wire;
  if (wire === 'gemini') return fromGeminiEmbedResponse(jsons[0], t.model, estimatedTokens);
  if (wire === 'bedrock') {
    const rows = jsons.map(fromTitanEmbed);
    const tokens = rows.reduce((n, r) => n + r.tokens, 0) || estimatedTokens;
    return {
      object: 'list',
      data: rows.map((r, index) => ({ object: 'embedding', index, embedding: r.embedding })),
      model: t.model,
      usage: { prompt_tokens: tokens, total_tokens: tokens },
    };
  }
  const r = (jsons[0] ?? {}) as Partial<EmbeddingResponse>;
  const tokens = r.usage?.prompt_tokens ?? estimatedTokens;
  return {
    object: 'list',
    data: r.data ?? [],
    model: r.model ?? t.model,
    usage: { prompt_tokens: tokens, total_tokens: r.usage?.total_tokens ?? tokens },
  };
}

/** OTel `gen_ai.provider.name` well-known values. */
export function otelProviderName(p: AiProviderKind): string {
  switch (p) {
    case 'gemini':
      return 'gcp.gemini';
    case 'bedrock':
      return 'aws.bedrock';
    case 'azure':
      return 'azure.ai.openai';
    case 'mistral':
      return 'mistral_ai';
    default:
      return p;
  }
}
