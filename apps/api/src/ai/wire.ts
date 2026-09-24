/**
 * The gateway's canonical wire shape: OpenAI Chat Completions + Embeddings.
 * Every provider adapter translates FROM these requests and TO these
 * responses/chunks, so `/ai/v1/chat/completions` speaks one dialect to apps
 * whatever answers upstream. Types are deliberately loose (`unknown` where a
 * provider may add fields) — the gateway forwards what it does not interpret.
 */

export interface ChatTextPart {
  type: 'text';
  text: string;
}
export interface ChatImagePart {
  type: 'image_url';
  image_url: { url: string; detail?: string };
}
export type ChatPart = ChatTextPart | ChatImagePart | { type: string; [k: string]: unknown };

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content: string | ChatPart[] | null;
  name?: string;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

export interface ChatTool {
  type: 'function';
  function: { name: string; description?: string; parameters?: Record<string, unknown>; strict?: boolean };
}

export type ChatToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } };

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean } | null;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[] | null;
  tools?: ChatTool[];
  tool_choice?: ChatToolChoice;
  user?: string;
  response_format?: { type: string; json_schema?: unknown };
  [k: string]: unknown;
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] };
    finish_reason: FinishReason;
  }>;
  usage: ChatUsage;
}

export interface ChunkToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function: { name?: string; arguments?: string };
}

export interface ChatChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: 'assistant'; content?: string | null; tool_calls?: ChunkToolCallDelta[] };
    finish_reason: FinishReason;
  }>;
  usage?: ChatUsage | null;
}

export interface EmbeddingRequest {
  model: string;
  input: string | string[];
  dimensions?: number;
  encoding_format?: 'float' | 'base64';
  user?: string;
}

export interface EmbeddingResponse {
  object: 'list';
  data: Array<{ object: 'embedding'; index: number; embedding: number[] }>;
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

// ── small helpers shared by the adapters ─────────────────────────────────────

export const nowSec = (): number => Math.floor(Date.now() / 1000);

let seq = 0;
/** Short unique id (`chatcmpl-…`, `call_…`) — not a secret. */
export function genId(prefix: string): string {
  seq = (seq + 1) % 1e6;
  return `${prefix}${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Plain text of a message's content (parts joined; images dropped). */
export function textOf(content: ChatMessage['content'] | unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : ''))
    .filter(Boolean)
    .join('\n');
}

/** `data:<mime>;base64,<data>` → parts, else null. */
export function parseDataUrl(url: string): { mime: string; data: string } | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return m ? { mime: m[1]!, data: m[2]! } : null;
}

export function stopList(stop: ChatRequest['stop']): string[] | undefined {
  if (!stop) return undefined;
  const list = Array.isArray(stop) ? stop : [stop];
  const out = list.filter((s) => typeof s === 'string' && s.length > 0);
  return out.length ? out : undefined;
}

export function maxTokensOf(req: ChatRequest, fallback: number): number {
  const v = req.max_completion_tokens ?? req.max_tokens;
  return typeof v === 'number' && v > 0 ? Math.floor(v) : fallback;
}

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Tool-call arguments string → object (invalid JSON → `{}` so the call still translates). */
export function parseArgs(args: string | undefined): Record<string, unknown> {
  if (!args) return {};
  const v = safeJson(args);
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function usageOf(inTokens: number, outTokens: number): ChatUsage {
  return { prompt_tokens: inTokens, completion_tokens: outTokens, total_tokens: inTokens + outTokens };
}

export function chunk(
  id: string,
  model: string,
  created: number,
  delta: ChatChunk['choices'][number]['delta'],
  finish: FinishReason = null,
): ChatChunk {
  return { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] };
}

/** A usage-only final chunk (`stream_options.include_usage`). */
export function usageChunk(id: string, model: string, created: number, usage: ChatUsage): ChatChunk {
  return { id, object: 'chat.completion.chunk', created, model, choices: [], usage };
}
