/**
 * OpenAI ⇄ AWS Bedrock Converse (`/model/{id}/converse`, `converse-stream`)
 * translation, plus Titan text embeddings (`/model/{id}/invoke`).
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
  type FinishReason,
} from './wire';

type Block = Record<string, unknown>;

export function bedrockFinish(reason: unknown): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'guardrail_intervened':
    case 'content_filtered':
      return 'content_filter';
    default:
      return reason == null ? null : 'stop';
  }
}

export function bedrockUrl(region: string, model: string, op: 'converse' | 'converse-stream' | 'invoke'): string {
  return `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/${op}`;
}

function userContent(content: ChatMessage['content']): Block[] {
  if (typeof content === 'string' || content == null) return [{ text: content || ' ' }];
  const out: Block[] = [];
  for (const p of content) {
    if (p.type === 'text') out.push({ text: (p as { text: string }).text });
    else if (p.type === 'image_url') {
      const d = parseDataUrl((p as { image_url?: { url?: string } }).image_url?.url ?? '');
      if (d) out.push({ image: { format: d.mime.replace(/^image\//, '').replace('jpg', 'jpeg'), source: { bytes: d.data } } });
    }
  }
  return out.length ? out : [{ text: ' ' }];
}

/** OpenAI chat request → Converse body. */
export function toBedrockRequest(req: ChatRequest): Record<string, unknown> {
  const system: Block[] = [];
  const messages: Array<{ role: 'user' | 'assistant'; content: Block[] }> = [];
  const push = (role: 'user' | 'assistant', content: Block[]): void => {
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(...content);
    else messages.push({ role, content });
  };
  for (const msg of req.messages) {
    if (msg.role === 'system' || msg.role === 'developer') {
      const t = textOf(msg.content);
      if (t) system.push({ text: t });
    } else if (msg.role === 'user') push('user', userContent(msg.content));
    else if (msg.role === 'assistant') {
      const blocks: Block[] = [];
      const t = textOf(msg.content);
      if (t) blocks.push({ text: t });
      for (const tc of msg.tool_calls ?? []) {
        blocks.push({ toolUse: { toolUseId: tc.id, name: tc.function.name, input: parseArgs(tc.function.arguments) } });
      }
      if (blocks.length) push('assistant', blocks);
    } else if (msg.role === 'tool') {
      push('user', [{ toolResult: { toolUseId: msg.tool_call_id ?? '', content: [{ text: textOf(msg.content) || ' ' }] } }]);
    }
  }
  const body: Record<string, unknown> = { messages };
  if (system.length) body.system = system;
  const inf: Record<string, unknown> = {};
  const max = maxTokensOf(req, 0);
  if (max) inf.maxTokens = max;
  if (typeof req.temperature === 'number') inf.temperature = req.temperature;
  if (typeof req.top_p === 'number') inf.topP = req.top_p;
  const stops = stopList(req.stop);
  if (stops) inf.stopSequences = stops;
  if (Object.keys(inf).length) body.inferenceConfig = inf;
  if (req.tools?.length) {
    const toolConfig: Record<string, unknown> = {
      tools: req.tools.map((t) => ({
        toolSpec: {
          name: t.function.name,
          ...(t.function.description ? { description: t.function.description } : {}),
          inputSchema: { json: t.function.parameters ?? { type: 'object', properties: {} } },
        },
      })),
    };
    const tc = req.tool_choice;
    if (tc === 'auto') toolConfig.toolChoice = { auto: {} };
    else if (tc === 'required') toolConfig.toolChoice = { any: {} };
    else if (tc && typeof tc === 'object') toolConfig.toolChoice = { tool: { name: tc.function.name } };
    body.toolConfig = toolConfig;
  }
  return body;
}

interface BedrockUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
}
const inOf = (u: BedrockUsage | undefined): number => (u?.inputTokens ?? 0) + (u?.cacheReadInputTokens ?? 0) + (u?.cacheWriteInputTokens ?? 0);

/** Converse response → OpenAI chat completion. */
export function fromBedrockResponse(json: unknown, model: string): ChatResponse {
  const r = (json ?? {}) as { output?: { message?: { content?: Block[] } }; stopReason?: string; usage?: BedrockUsage };
  const texts: string[] = [];
  const toolCalls: ChatToolCall[] = [];
  for (const b of r.output?.message?.content ?? []) {
    if (typeof b.text === 'string') texts.push(b.text);
    const tu = b.toolUse as { toolUseId?: string; name?: string; input?: unknown } | undefined;
    if (tu?.name) toolCalls.push({ id: tu.toolUseId ?? genId('call_'), type: 'function', function: { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) } });
  }
  return {
    id: genId('chatcmpl-'),
    object: 'chat.completion',
    created: nowSec(),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: texts.length ? texts.join('') : null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
        finish_reason: bedrockFinish(r.stopReason ?? 'end_turn'),
      },
    ],
    usage: usageOf(inOf(r.usage), r.usage?.outputTokens ?? 0),
  };
}

/** converse-stream events (decoded from the AWS event-stream) → OpenAI chunks. */
export class BedrockToOpenAIStream {
  id = genId('chatcmpl-');
  created = nowSec();
  inTokens = 0;
  outTokens = 0;
  finish: FinishReason = null;
  error: string | null = null;
  private toolIndex = new Map<number, number>();
  private nextTool = 0;

  constructor(private readonly model: string) {}

  /** `eventType` = the `:event-type` header (or `:exception-type`). */
  feed(eventType: string | null, data: string): ChatChunk[] {
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return [];
    }
    const m = this.model;
    switch (eventType) {
      case 'messageStart':
        return [chunk(this.id, m, this.created, { role: 'assistant', content: '' })];
      case 'contentBlockStart': {
        const tu = ((j.start ?? {}) as { toolUse?: { toolUseId?: string; name?: string } }).toolUse;
        if (!tu) return [];
        const idx = this.nextTool++;
        this.toolIndex.set(Number(j.contentBlockIndex ?? 0), idx);
        return [chunk(this.id, m, this.created, { tool_calls: [{ index: idx, id: tu.toolUseId ?? genId('call_'), type: 'function', function: { name: tu.name ?? '', arguments: '' } }] })];
      }
      case 'contentBlockDelta': {
        const d = (j.delta ?? {}) as { text?: string; toolUse?: { input?: string } };
        if (typeof d.text === 'string') return [chunk(this.id, m, this.created, { content: d.text })];
        if (typeof d.toolUse?.input === 'string') {
          const idx = this.toolIndex.get(Number(j.contentBlockIndex ?? 0)) ?? 0;
          return [chunk(this.id, m, this.created, { tool_calls: [{ index: idx, function: { arguments: d.toolUse.input } }] })];
        }
        return [];
      }
      case 'messageStop':
        this.finish = bedrockFinish(j.stopReason);
        return [chunk(this.id, m, this.created, {}, this.finish ?? 'stop')];
      case 'metadata': {
        const u = j.usage as BedrockUsage | undefined;
        if (u) {
          this.inTokens = inOf(u);
          this.outTokens = u.outputTokens ?? 0;
        }
        return [];
      }
      default:
        if (typeof j.message === 'string') this.error = j.message;
        return [];
    }
  }

  usage(): ChatChunk {
    return usageChunk(this.id, this.model, this.created, usageOf(this.inTokens, this.outTokens));
  }
}

// ── Titan embeddings ─────────────────────────────────────────────────────────

export function toTitanEmbedBody(text: string, dimensions?: number): Record<string, unknown> {
  return { inputText: text, ...(dimensions ? { dimensions } : {}) };
}

export function fromTitanEmbed(json: unknown): { embedding: number[]; tokens: number } {
  const r = (json ?? {}) as { embedding?: number[]; inputTextTokenCount?: number };
  return { embedding: r.embedding ?? [], tokens: r.inputTextTokenCount ?? 0 };
}
