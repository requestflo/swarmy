/**
 * Gateway traces in the OpenTelemetry GenAI semantic conventions, linked to
 * the calling request's trace (W3C `traceparent`), exported as OTLP/HTTP JSON
 * to the swarmy collector (→ ClickHouse) when an endpoint is configured.
 *
 *   SERVER span  "POST /ai/v1/chat/completions"   (child of the app's span)
 *     └ CLIENT span "chat gpt-5-mini"             (one per upstream attempt)
 *
 * Resource attributes carry `swarmy.org_id` / `swarmy.stack` so the
 * org-scoped trace queries find them. Prompts and completions are NEVER put
 * on spans (the opt-in, redacted request log is the only place a prompt goes).
 */
import { randomBytes } from 'node:crypto';

export interface TraceContext {
  traceId: string;
  /** The caller's span id (parent of our SERVER span), if any. */
  parentSpanId: string | null;
  sampled: boolean;
}

const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;

export function newSpanId(): string {
  return randomBytes(8).toString('hex');
}
export function newTraceId(): string {
  return randomBytes(16).toString('hex');
}

/** Parse a W3C traceparent (`00-<trace>-<span>-<flags>`); a fresh trace when absent/invalid. */
export function parseTraceparent(h: string | null | undefined): TraceContext {
  const m = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec((h ?? '').trim().toLowerCase());
  if (m && m[1] !== 'ff' && HEX32.test(m[2]!) && !/^0+$/.test(m[2]!) && HEX16.test(m[3]!) && !/^0+$/.test(m[3]!)) {
    return { traceId: m[2]!, parentSpanId: m[3]!, sampled: (parseInt(m[4]!, 16) & 1) === 1 };
  }
  return { traceId: newTraceId(), parentSpanId: null, sampled: true };
}

export function formatTraceparent(traceId: string, spanId: string, sampled = true): string {
  return `00-${traceId}-${spanId}-${sampled ? '01' : '00'}`;
}

export type AttrValue = string | number | boolean | string[] | null | undefined;

export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: 'server' | 'client';
  startMs: number;
  endMs: number;
  attributes: Record<string, AttrValue>;
  error: string | null;
  resource: { orgId: string; stack: string | null };
}

export interface GenAiAttrsInput {
  operation: 'chat' | 'embeddings';
  provider: string;
  requestModel: string;
  responseModel?: string | null;
  responseId?: string | null;
  finishReasons?: string[];
  inTokens?: number;
  outTokens?: number;
  maxTokens?: number | null;
  temperature?: number | null;
  topP?: number | null;
  serverAddress?: string | null;
  serverPort?: number | null;
  errorType?: string | null;
}

/** GenAI semantic-convention attributes (v1.3x `gen_ai.*`). */
export function genAiAttributes(i: GenAiAttrsInput): Record<string, AttrValue> {
  return {
    'gen_ai.operation.name': i.operation,
    'gen_ai.provider.name': i.provider,
    'gen_ai.request.model': i.requestModel,
    'gen_ai.response.model': i.responseModel ?? undefined,
    'gen_ai.response.id': i.responseId ?? undefined,
    'gen_ai.response.finish_reasons': i.finishReasons?.length ? i.finishReasons : undefined,
    'gen_ai.usage.input_tokens': i.inTokens,
    'gen_ai.usage.output_tokens': i.outTokens,
    'gen_ai.request.max_tokens': i.maxTokens ?? undefined,
    'gen_ai.request.temperature': i.temperature ?? undefined,
    'gen_ai.request.top_p': i.topP ?? undefined,
    'server.address': i.serverAddress ?? undefined,
    'server.port': i.serverPort ?? undefined,
    'error.type': i.errorType ?? undefined,
  };
}

function otlpValue(v: AttrValue): Record<string, unknown> | null {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return { arrayValue: { values: v.map((s) => ({ stringValue: s })) } };
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  return { stringValue: v };
}

function otlpAttrs(a: Record<string, AttrValue>): Array<{ key: string; value: Record<string, unknown> }> {
  const out: Array<{ key: string; value: Record<string, unknown> }> = [];
  for (const [key, v] of Object.entries(a)) {
    const value = otlpValue(v);
    if (value) out.push({ key, value });
  }
  return out;
}

const ms2ns = (ms: number): string => `${BigInt(Math.round(ms)) * 1_000_000n}`;

/** Spans → an OTLP/HTTP JSON `ExportTraceServiceRequest` (one resource per org/stack). */
export function toOtlp(spans: readonly SpanRecord[]): Record<string, unknown> {
  const groups = new Map<string, SpanRecord[]>();
  for (const s of spans) {
    const k = `${s.resource.orgId}\u0000${s.resource.stack ?? ''}`;
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  return {
    resourceSpans: [...groups.values()].map((list) => ({
      resource: {
        attributes: otlpAttrs({
          'service.name': 'swarmy-ai-gateway',
          'swarmy.org_id': list[0]!.resource.orgId,
          'swarmy.stack': list[0]!.resource.stack ?? undefined,
        }),
      },
      scopeSpans: [
        {
          scope: { name: 'swarmy.ai-gateway' },
          spans: list.map((s) => ({
            traceId: s.traceId,
            spanId: s.spanId,
            ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
            name: s.name,
            kind: s.kind === 'server' ? 2 : 3,
            startTimeUnixNano: ms2ns(s.startMs),
            endTimeUnixNano: ms2ns(s.endMs),
            attributes: otlpAttrs(s.attributes),
            status: s.error ? { code: 2, message: s.error.slice(0, 200) } : { code: 1 },
          })),
        },
      ],
    })),
  };
}

/** Where spans go: `SWARMY_AI_OTLP_ENDPOINT` → `OTEL_EXPORTER_OTLP_ENDPOINT` (+ /v1/traces). */
export function otlpTracesUrl(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.SWARMY_AI_OTLP_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!raw || env.SWARMY_AI_TRACES === 'off') return null;
  const base = raw.replace(/\/+$/, '');
  return base.endsWith('/v1/traces') ? base : `${base}/v1/traces`;
}

/** Batching best-effort exporter: flush every 2s or at 256 spans; never throws. */
export class SpanExporter {
  private buf: SpanRecord[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(
    private readonly url: string | null = otlpTracesUrl(),
    private readonly post: (url: string, body: string) => Promise<unknown> = (url, body) =>
      fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(5000) }),
  ) {}

  get enabled(): boolean {
    return this.url !== null;
  }

  add(spans: readonly SpanRecord[]): void {
    if (!this.url) return;
    this.buf.push(...spans);
    if (this.buf.length > 4096) this.buf.splice(0, this.buf.length - 4096);
    if (this.buf.length >= 256) void this.flush();
    else if (!this.timer) this.timer = setTimeout(() => void this.flush(), 2000);
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.url || this.buf.length === 0) return;
    const batch = this.buf.splice(0);
    try {
      await this.post(this.url, JSON.stringify(toOtlp(batch)));
    } catch {
      // Tracing must never break a request; a dropped batch is acceptable.
    }
  }
}
