/**
 * OpenAI ⇄ Google Gemini (`generateContent` / `streamGenerateContent?alt=sse`
 * / `batchEmbedContents`) translation.
 */
import {
  chunk,
  genId,
  nowSec,
  parseArgs,
  parseDataUrl,
  stopList,
  maxTokensOf,
  textOf,
  usageChunk,
  usageOf,
  type ChatChunk,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type ChatToolCall,
  type EmbeddingRequest,
  type EmbeddingResponse,
  type FinishReason,
} from './wire';

type Part = Record<string, unknown>;

/** Gemini's OpenAPI-subset schema: strip JSON-Schema keywords it rejects. */
export function geminiSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(geminiSchema);
  if (!s || typeof s !== 'object') return s;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
    if (k === '$schema' || k === 'additionalProperties' || k === '$id' || k === '$defs' || k === 'strict') continue;
    out[k] = geminiSchema(v);
  }
  return out;
}

function userParts(content: ChatMessage['content']): Part[] {
  if (typeof content === 'string' || content == null) return [{ text: content ?? '' }];
  const out: Part[] = [];
  for (const p of content) {
    if (p.type === 'text') out.push({ text: (p as { text: string }).text });
    else if (p.type === 'image_url') {
      const url = (p as { image_url?: { url?: string } }).image_url?.url ?? '';
      const d = parseDataUrl(url);
      out.push(d ? { inlineData: { mimeType: d.mime, data: d.data } } : { fileData: { fileUri: url } });
    }
  }
  return out.length ? out : [{ text: '' }];
}

export function geminiFinish(reason: unknown, hasToolCalls: boolean): FinishReason {
  if (reason == null) return null;
  if (hasToolCalls) return 'tool_calls';
  switch (reason) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
      return 'content_filter';
    default:
      return 'stop';
  }
}

/** OpenAI chat request → Gemini generateContent body. */
export function toGeminiRequest(req: ChatRequest): Record<string, unknown> {
  const system: string[] = [];
  const contents: Array<{ role: 'user' | 'model'; parts: Part[] }> = [];
  const toolNames = new Map<string, string>();
  const push = (role: 'user' | 'model', parts: Part[]): void => {
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  for (const msg of req.messages) {
    if (msg.role === 'system' || msg.role === 'developer') {
      const t = textOf(msg.content);
      if (t) system.push(t);
    } else if (msg.role === 'user') push('user', userParts(msg.content));
    else if (msg.role === 'assistant') {
      const parts: Part[] = [];
      const t = textOf(msg.content);
      if (t) parts.push({ text: t });
      for (const tc of msg.tool_calls ?? []) {
        toolNames.set(tc.id, tc.function.name);
        parts.push({ functionCall: { name: tc.function.name, args: parseArgs(tc.function.arguments) } });
      }
      if (parts.length) push('model', parts);
    } else if (msg.role === 'tool') {
      const name = toolNames.get(msg.tool_call_id ?? '') ?? msg.name ?? 'tool';
      const text = textOf(msg.content);
      let response: unknown;
      try {
        const parsed = JSON.parse(text) as unknown;
        response = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { content: parsed };
      } catch {
        response = { content: text };
      }
      push('user', [{ functionResponse: { name, response } }]);
    }
  }
  const body: Record<string, unknown> = { contents };
  if (system.length) body.systemInstruction = { parts: [{ text: system.join('\n\n') }] };
  const gc: Record<string, unknown> = {};
  const max = maxTokensOf(req, 0);
  if (max) gc.maxOutputTokens = max;
  if (typeof req.temperature === 'number') gc.temperature = req.temperature;
  if (typeof req.top_p === 'number') gc.topP = req.top_p;
  const stops = stopList(req.stop);
  if (stops) gc.stopSequences = stops;
  if (req.response_format?.type === 'json_object' || req.response_format?.type === 'json_schema') gc.responseMimeType = 'application/json';
  if (Object.keys(gc).length) body.generationConfig = gc;
  if (req.tools?.length) {
    body.tools = [
      {
        functionDeclarations: req.tools.map((t) => ({
          name: t.function.name,
          ...(t.function.description ? { description: t.function.description } : {}),
          ...(t.function.parameters ? { parameters: geminiSchema(t.function.parameters) } : {}),
        })),
      },
    ];
    const tc = req.tool_choice;
    if (tc === 'required') body.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
    else if (tc === 'none') body.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
    else if (tc && typeof tc === 'object') body.toolConfig = { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [tc.function.name] } };
  }
  return body;
}

interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
}

function parts(json: unknown): { texts: string[]; calls: Array<{ name: string; args: unknown }>; finish: unknown; usage: GeminiUsage | undefined; model?: string; id?: string } {
  const r = (json ?? {}) as {
    candidates?: Array<{ content?: { parts?: Part[] }; finishReason?: string }>;
    usageMetadata?: GeminiUsage;
    modelVersion?: string;
    responseId?: string;
  };
  const cand = r.candidates?.[0];
  const texts: string[] = [];
  const calls: Array<{ name: string; args: unknown }> = [];
  for (const p of cand?.content?.parts ?? []) {
    if (p.thought === true) continue;
    if (typeof p.text === 'string') texts.push(p.text);
    const fc = p.functionCall as { name?: string; args?: unknown } | undefined;
    if (fc?.name) calls.push({ name: fc.name, args: fc.args ?? {} });
  }
  return { texts, calls, finish: cand?.finishReason, usage: r.usageMetadata, model: r.modelVersion, id: r.responseId };
}

const outTokensOf = (u: GeminiUsage | undefined): number => (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0);

/** Gemini generateContent response → OpenAI chat completion. */
export function fromGeminiResponse(json: unknown, model: string): ChatResponse {
  const p = parts(json);
  const toolCalls: ChatToolCall[] = p.calls.map((c, i) => ({
    id: `call_${i}_${genId('')}`,
    type: 'function',
    function: { name: c.name, arguments: JSON.stringify(c.args) },
  }));
  return {
    id: p.id ? `chatcmpl-${p.id}` : genId('chatcmpl-'),
    object: 'chat.completion',
    created: nowSec(),
    model: p.model ?? model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: p.texts.length ? p.texts.join('') : null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
        finish_reason: geminiFinish(p.finish ?? 'STOP', toolCalls.length > 0),
      },
    ],
    usage: usageOf(p.usage?.promptTokenCount ?? 0, outTokensOf(p.usage)),
  };
}

/** Gemini SSE (each `data:` is a partial GenerateContentResponse) → OpenAI chunks. */
export class GeminiToOpenAIStream {
  id = genId('chatcmpl-');
  created = nowSec();
  inTokens = 0;
  outTokens = 0;
  finish: FinishReason = null;
  private started = false;
  private tools = 0;

  constructor(private readonly model: string) {}

  feed(_event: string | null, data: string): ChatChunk[] {
    let j: unknown;
    try {
      j = JSON.parse(data);
    } catch {
      return [];
    }
    const p = parts(j);
    const out: ChatChunk[] = [];
    if (!this.started) {
      this.started = true;
      out.push(chunk(this.id, this.model, this.created, { role: 'assistant', content: '' }));
    }
    if (p.usage) {
      this.inTokens = p.usage.promptTokenCount ?? this.inTokens;
      this.outTokens = outTokensOf(p.usage) || this.outTokens;
    }
    const text = p.texts.join('');
    if (text) out.push(chunk(this.id, this.model, this.created, { content: text }));
    for (const c of p.calls) {
      const index = this.tools++;
      out.push(
        chunk(this.id, this.model, this.created, {
          tool_calls: [{ index, id: `call_${index}_${genId('')}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }],
        }),
      );
    }
    if (p.finish) {
      this.finish = geminiFinish(p.finish, this.tools > 0);
      out.push(chunk(this.id, this.model, this.created, {}, this.finish));
    }
    return out;
  }

  usage(): ChatChunk {
    return usageChunk(this.id, this.model, this.created, usageOf(this.inTokens, this.outTokens));
  }
}

// ── embeddings ───────────────────────────────────────────────────────────────

export function toGeminiEmbedRequest(req: EmbeddingRequest, model: string): Record<string, unknown> {
  const inputs = Array.isArray(req.input) ? req.input : [req.input];
  return {
    requests: inputs.map((text) => ({
      model: `models/${model}`,
      content: { parts: [{ text }] },
      ...(req.dimensions ? { outputDimensionality: req.dimensions } : {}),
    })),
  };
}

export function fromGeminiEmbedResponse(json: unknown, model: string, estimatedTokens: number): EmbeddingResponse {
  const list = ((json ?? {}) as { embeddings?: Array<{ values?: number[] }> }).embeddings ?? [];
  return {
    object: 'list',
    data: list.map((e, index) => ({ object: 'embedding', index, embedding: e.values ?? [] })),
    model,
    usage: { prompt_tokens: estimatedTokens, total_tokens: estimatedTokens },
  };
}
