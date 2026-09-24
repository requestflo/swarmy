/**
 * OpenAI ⇄ Anthropic Messages translation, both directions:
 *   - chat-completions IN → Anthropic upstream (request, response, stream);
 *   - Anthropic `/v1/messages` IN → any OpenAI-shaped upstream (request,
 *     response, stream), so ANTHROPIC_BASE_URL apps can use `smart` even
 *     when it resolves to a non-Anthropic model.
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
interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | Block[];
}

export const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;

export function anthropicFinish(stop: unknown): FinishReason {
  switch (stop) {
    case 'end_turn':
    case 'stop_sequence':
    case 'pause_turn':
      return 'stop';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    default:
      return stop == null ? null : 'stop';
  }
}

function imageBlock(url: string): Block {
  const d = parseDataUrl(url);
  return d
    ? { type: 'image', source: { type: 'base64', media_type: d.mime, data: d.data } }
    : { type: 'image', source: { type: 'url', url } };
}

function userBlocks(content: ChatMessage['content']): string | Block[] {
  if (typeof content === 'string' || content == null) return content ?? '';
  const out: Block[] = [];
  for (const p of content) {
    if (p.type === 'text' && typeof (p as { text?: unknown }).text === 'string') out.push({ type: 'text', text: (p as { text: string }).text });
    else if (p.type === 'image_url') {
      const url = (p as { image_url?: { url?: string } }).image_url?.url;
      if (url) out.push(imageBlock(url));
    }
  }
  return out;
}

/** Push a message, merging consecutive same-role turns (Anthropic alternates strictly). */
function pushMerged(list: AnthropicMessage[], msg: AnthropicMessage): void {
  const last = list[list.length - 1];
  if (!last || last.role !== msg.role) {
    list.push(msg);
    return;
  }
  const toBlocks = (c: string | Block[]): Block[] => (typeof c === 'string' ? (c ? [{ type: 'text', text: c }] : []) : c);
  last.content = [...toBlocks(last.content), ...toBlocks(msg.content)];
}

/** OpenAI chat request → Anthropic Messages body (model = the target model). */
export function toAnthropicRequest(req: ChatRequest, model: string): Record<string, unknown> {
  const system: string[] = [];
  const messages: AnthropicMessage[] = [];
  for (const msg of req.messages) {
    if (msg.role === 'system' || msg.role === 'developer') {
      const t = textOf(msg.content);
      if (t) system.push(t);
    } else if (msg.role === 'user') {
      pushMerged(messages, { role: 'user', content: userBlocks(msg.content) });
    } else if (msg.role === 'assistant') {
      const blocks: Block[] = [];
      const t = textOf(msg.content);
      if (t) blocks.push({ type: 'text', text: t });
      for (const tc of msg.tool_calls ?? []) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: parseArgs(tc.function.arguments) });
      }
      pushMerged(messages, { role: 'assistant', content: blocks.length ? blocks : '' });
    } else if (msg.role === 'tool') {
      pushMerged(messages, {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: msg.tool_call_id ?? '', content: textOf(msg.content) }],
      });
    }
  }
  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokensOf(req, ANTHROPIC_DEFAULT_MAX_TOKENS),
    messages,
  };
  if (system.length) body.system = system.join('\n\n');
  if (typeof req.temperature === 'number') body.temperature = req.temperature;
  if (typeof req.top_p === 'number') body.top_p = req.top_p;
  const stops = stopList(req.stop);
  if (stops) body.stop_sequences = stops;
  if (req.stream) body.stream = true;
  if (req.user) body.metadata = { user_id: req.user };
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      name: t.function.name,
      ...(t.function.description ? { description: t.function.description } : {}),
      input_schema: t.function.parameters ?? { type: 'object', properties: {} },
    }));
  }
  const tc = req.tool_choice;
  if (tc && req.tools?.length) {
    if (tc === 'auto') body.tool_choice = { type: 'auto' };
    else if (tc === 'required') body.tool_choice = { type: 'any' };
    else if (tc === 'none') body.tool_choice = { type: 'none' };
    else if (typeof tc === 'object') body.tool_choice = { type: 'tool', name: tc.function.name };
  }
  return body;
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export function anthropicInputTokens(u: AnthropicUsage | undefined): number {
  return (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0);
}

/** Anthropic Messages response → OpenAI chat completion. */
export function fromAnthropicResponse(json: unknown, model: string): ChatResponse {
  const r = (json ?? {}) as { id?: string; model?: string; content?: Block[]; stop_reason?: string; usage?: AnthropicUsage };
  const texts: string[] = [];
  const toolCalls: ChatToolCall[] = [];
  for (const b of r.content ?? []) {
    if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
    else if (b.type === 'tool_use') {
      toolCalls.push({
        id: String(b.id ?? genId('call_')),
        type: 'function',
        function: { name: String(b.name ?? ''), arguments: JSON.stringify(b.input ?? {}) },
      });
    }
  }
  const inTok = anthropicInputTokens(r.usage);
  return {
    id: r.id ?? genId('chatcmpl-'),
    object: 'chat.completion',
    created: nowSec(),
    model: r.model ?? model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: texts.length ? texts.join('') : null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
        finish_reason: anthropicFinish(r.stop_reason),
      },
    ],
    usage: usageOf(inTok, r.usage?.output_tokens ?? 0),
  };
}

/** Stateful Anthropic SSE → OpenAI chunk translator. */
export class AnthropicToOpenAIStream {
  id = genId('chatcmpl-');
  created = nowSec();
  inTokens = 0;
  outTokens = 0;
  finish: FinishReason = null;
  responseModel: string | null = null;
  private toolIndex = new Map<number, number>();
  private nextTool = 0;

  constructor(private readonly model: string) {}

  feed(event: string | null, data: string): ChatChunk[] {
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return [];
    }
    const type = (j.type as string | undefined) ?? event;
    const m = this.responseModel ?? this.model;
    switch (type) {
      case 'message_start': {
        const msg = (j.message ?? {}) as { id?: string; model?: string; usage?: AnthropicUsage };
        if (msg.id) this.id = msg.id;
        if (msg.model) this.responseModel = msg.model;
        this.inTokens = anthropicInputTokens(msg.usage);
        this.outTokens = msg.usage?.output_tokens ?? 0;
        return [chunk(this.id, this.responseModel ?? m, this.created, { role: 'assistant', content: '' })];
      }
      case 'content_block_start': {
        const b = (j.content_block ?? {}) as Block;
        if (b.type !== 'tool_use') return [];
        const idx = this.nextTool++;
        this.toolIndex.set(Number(j.index ?? 0), idx);
        return [
          chunk(this.id, m, this.created, {
            tool_calls: [{ index: idx, id: String(b.id ?? genId('call_')), type: 'function', function: { name: String(b.name ?? ''), arguments: '' } }],
          }),
        ];
      }
      case 'content_block_delta': {
        const d = (j.delta ?? {}) as Block;
        if (d.type === 'text_delta' && typeof d.text === 'string') return [chunk(this.id, m, this.created, { content: d.text })];
        if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
          const idx = this.toolIndex.get(Number(j.index ?? 0)) ?? 0;
          return [chunk(this.id, m, this.created, { tool_calls: [{ index: idx, function: { arguments: d.partial_json } }] })];
        }
        return [];
      }
      case 'message_delta': {
        const d = (j.delta ?? {}) as { stop_reason?: string };
        const u = j.usage as AnthropicUsage | undefined;
        if (u?.output_tokens !== undefined) this.outTokens = u.output_tokens;
        if (u && (u.input_tokens !== undefined || u.cache_read_input_tokens !== undefined)) this.inTokens = anthropicInputTokens(u);
        this.finish = anthropicFinish(d.stop_reason);
        return [chunk(this.id, m, this.created, {}, this.finish ?? 'stop')];
      }
      default:
        return [];
    }
  }

  /** Final usage chunk (sent when the caller asked for `include_usage`). */
  usage(): ChatChunk {
    return usageChunk(this.id, this.responseModel ?? this.model, this.created, usageOf(this.inTokens, this.outTokens));
  }
}

// ── Anthropic IN → OpenAI-shaped upstream ────────────────────────────────────

function anthropicContentToOpenAI(content: unknown): { text: string; parts: ChatMessage['content']; toolCalls: ChatToolCall[]; toolResults: Array<{ id: string; text: string }> } {
  const toolCalls: ChatToolCall[] = [];
  const toolResults: Array<{ id: string; text: string }> = [];
  if (typeof content === 'string') return { text: content, parts: content, toolCalls, toolResults };
  const parts: Array<Record<string, unknown>> = [];
  const texts: string[] = [];
  for (const b of Array.isArray(content) ? (content as Block[]) : []) {
    if (b.type === 'text' && typeof b.text === 'string') {
      texts.push(b.text);
      parts.push({ type: 'text', text: b.text });
    } else if (b.type === 'image') {
      const src = (b.source ?? {}) as { type?: string; media_type?: string; data?: string; url?: string };
      const url = src.type === 'base64' ? `data:${src.media_type};base64,${src.data}` : src.url;
      if (url) parts.push({ type: 'image_url', image_url: { url } });
    } else if (b.type === 'tool_use') {
      toolCalls.push({ id: String(b.id), type: 'function', function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) } });
    } else if (b.type === 'tool_result') {
      const c = b.content;
      toolResults.push({ id: String(b.tool_use_id), text: typeof c === 'string' ? c : textOf(c) });
    }
  }
  const onlyText = parts.every((p) => p.type === 'text');
  return { text: texts.join('\n'), parts: onlyText ? texts.join('\n') : (parts as ChatMessage['content']), toolCalls, toolResults };
}

/** Anthropic Messages body → OpenAI chat request (model = the target model). */
export function anthropicToOpenAIRequest(body: Record<string, unknown>, model: string): ChatRequest {
  const messages: ChatMessage[] = [];
  const sys = body.system;
  const sysText = typeof sys === 'string' ? sys : textOf(sys);
  if (sysText) messages.push({ role: 'system', content: sysText });
  for (const raw of Array.isArray(body.messages) ? (body.messages as Array<{ role?: string; content?: unknown }>) : []) {
    const c = anthropicContentToOpenAI(raw.content);
    if (raw.role === 'assistant') {
      messages.push({ role: 'assistant', content: c.text || null, ...(c.toolCalls.length ? { tool_calls: c.toolCalls } : {}) });
    } else {
      for (const tr of c.toolResults) messages.push({ role: 'tool', tool_call_id: tr.id, content: tr.text });
      const hasContent = typeof c.parts === 'string' ? c.parts.length > 0 : (c.parts?.length ?? 0) > 0;
      if (hasContent) messages.push({ role: 'user', content: c.parts });
    }
  }
  const req: ChatRequest = { model, messages };
  if (typeof body.max_tokens === 'number') req.max_tokens = body.max_tokens;
  if (typeof body.temperature === 'number') req.temperature = body.temperature;
  if (typeof body.top_p === 'number') req.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences)) req.stop = body.stop_sequences as string[];
  if (body.stream === true) {
    req.stream = true;
    req.stream_options = { include_usage: true };
  }
  if (Array.isArray(body.tools)) {
    req.tools = (body.tools as Block[])
      .filter((t) => typeof t.name === 'string' && t.input_schema)
      .map((t) => ({
        type: 'function' as const,
        function: {
          name: String(t.name),
          ...(typeof t.description === 'string' ? { description: t.description } : {}),
          parameters: t.input_schema as Record<string, unknown>,
        },
      }));
  }
  const tc = body.tool_choice as { type?: string; name?: string } | undefined;
  if (tc?.type === 'auto') req.tool_choice = 'auto';
  else if (tc?.type === 'any') req.tool_choice = 'required';
  else if (tc?.type === 'none') req.tool_choice = 'none';
  else if (tc?.type === 'tool' && tc.name) req.tool_choice = { type: 'function', function: { name: tc.name } };
  return req;
}

const toAnthropicStop = (f: FinishReason): string =>
  f === 'length' ? 'max_tokens' : f === 'tool_calls' ? 'tool_use' : f === 'content_filter' ? 'refusal' : 'end_turn';

/** OpenAI chat completion → Anthropic Messages response. */
export function openAIToAnthropicResponse(r: ChatResponse, requestedModel: string): Record<string, unknown> {
  const choice = r.choices[0];
  const content: Block[] = [];
  if (choice?.message.content) content.push({ type: 'text', text: choice.message.content });
  for (const tc of choice?.message.tool_calls ?? []) {
    content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: parseArgs(tc.function.arguments) });
  }
  return {
    id: r.id.startsWith('msg_') ? r.id : `msg_${r.id}`,
    type: 'message',
    role: 'assistant',
    model: r.model || requestedModel,
    content,
    stop_reason: toAnthropicStop(choice?.finish_reason ?? 'stop'),
    stop_sequence: null,
    usage: { input_tokens: r.usage.prompt_tokens, output_tokens: r.usage.completion_tokens },
  };
}

export interface AnthropicSseOut {
  event: string;
  data: Record<string, unknown>;
}

/** Stateful OpenAI chunk → Anthropic SSE event translator. */
export class OpenAIToAnthropicStream {
  private started = false;
  private block: { index: number; kind: 'text' | 'tool' } | null = null;
  private nextIndex = 0;
  private toolBlocks = new Map<number, number>();
  private finish: FinishReason = null;
  inTokens = 0;
  outTokens = 0;
  private id = genId('msg_');

  constructor(private readonly model: string) {}

  private start(out: AnthropicSseOut[]): void {
    if (this.started) return;
    this.started = true;
    out.push({
      event: 'message_start',
      data: {
        type: 'message_start',
        message: { id: this.id, type: 'message', role: 'assistant', model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
      },
    });
  }

  private closeBlock(out: AnthropicSseOut[]): void {
    if (!this.block) return;
    out.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: this.block.index } });
    this.block = null;
  }

  feed(c: ChatChunk): AnthropicSseOut[] {
    const out: AnthropicSseOut[] = [];
    this.start(out);
    if (c.usage) {
      this.inTokens = c.usage.prompt_tokens;
      this.outTokens = c.usage.completion_tokens;
    }
    const ch = c.choices[0];
    if (!ch) return out;
    const d = ch.delta;
    if (typeof d.content === 'string' && d.content) {
      if (this.block?.kind !== 'text') {
        this.closeBlock(out);
        this.block = { index: this.nextIndex++, kind: 'text' };
        out.push({ event: 'content_block_start', data: { type: 'content_block_start', index: this.block.index, content_block: { type: 'text', text: '' } } });
      }
      out.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: this.block.index, delta: { type: 'text_delta', text: d.content } } });
    }
    for (const tc of d.tool_calls ?? []) {
      let idx = this.toolBlocks.get(tc.index);
      if (idx === undefined) {
        this.closeBlock(out);
        idx = this.nextIndex++;
        this.toolBlocks.set(tc.index, idx);
        this.block = { index: idx, kind: 'tool' };
        out.push({
          event: 'content_block_start',
          data: { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: tc.id ?? genId('toolu_'), name: tc.function.name ?? '', input: {} } },
        });
      }
      if (tc.function.arguments) {
        out.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } } });
      }
    }
    if (ch.finish_reason) this.finish = ch.finish_reason;
    return out;
  }

  end(): AnthropicSseOut[] {
    const out: AnthropicSseOut[] = [];
    this.start(out);
    this.closeBlock(out);
    out.push({
      event: 'message_delta',
      data: { type: 'message_delta', delta: { stop_reason: toAnthropicStop(this.finish ?? 'stop'), stop_sequence: null }, usage: { input_tokens: this.inTokens, output_tokens: this.outTokens } },
    });
    out.push({ event: 'message_stop', data: { type: 'message_stop' } });
    return out;
  }
}
