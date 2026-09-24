/**
 * Local end-to-end check against a real Ollama container (the in-cluster
 * provider path): the same adapters, framing and translators the gateway uses,
 * against the live OpenAI-compatible Ollama API. Skipped unless
 * `SWARMY_AI_E2E_OLLAMA` points at one:
 *
 *   docker run -d --name swarmy-ollama-e2e -p 11434:11434 ollama/ollama
 *   docker exec swarmy-ollama-e2e ollama pull qwen2.5:0.5b
 *   docker exec swarmy-ollama-e2e ollama pull all-minilm
 *   SWARMY_AI_E2E_OLLAMA=http://localhost:11434 bun test src/ai/ollama.e2e.test.ts
 *
 * Models: `SWARMY_AI_E2E_CHAT` (default qwen2.5:0.5b), `SWARMY_AI_E2E_EMBED`
 * (default all-minilm).
 */
import { describe, expect, it } from 'bun:test';
import { discoverInClusterModels, resolveModel, withDiscovered } from '@swarmy/core/views';
import { buildChat, buildEmbed, chatStream, parseChat, parseEmbed, type Target } from './adapters';
import { SseDecoder } from './framing';
import type { ChatChunk, ChatRequest } from './wire';

const BASE = process.env.SWARMY_AI_E2E_OLLAMA;
const CHAT = process.env.SWARMY_AI_E2E_CHAT ?? 'qwen2.5:0.5b';
const EMBED = process.env.SWARMY_AI_E2E_EMBED ?? 'all-minilm';
const run = BASE ? describe : describe.skip;

run('Ollama end to end (in-cluster provider)', () => {
  // Resolved exactly as the gateway does: discovered from a live service, then `ollama/<model>`.
  const found = discoverInClusterModels([{ name: 'llm_ollama', image: 'ollama/ollama:0.34.4', stack: 'llm' }]);
  const providers = withDiscovered([{ kind: 'ollama', baseUrl: BASE!, isDefault: true }], found);
  const target = (model: string): Target => ({ provider: 'ollama', model, apiKey: null, descriptor: providers[0]! });

  it('resolves ollama/<model> to the in-cluster provider', () => {
    const r = resolveModel(`ollama/${CHAT}`, { providers, routes: {} })!;
    expect(r.targets).toEqual([{ provider: 'ollama', model: CHAT }]);
    expect(providers[0]!.discovered?.service).toBe('llm_ollama');
  });

  it('non-streaming chat', async () => {
    const up = buildChat(target(CHAT), { model: 'x', max_tokens: 16, temperature: 0, messages: [{ role: 'user', content: 'Reply with the single word: pong' }] });
    const res = await fetch(up.url, { method: 'POST', headers: up.headers, body: up.body });
    expect(res.status).toBe(200);
    const r = parseChat(target(CHAT), await res.json());
    expect((r.choices[0]?.message.content ?? '').length).toBeGreaterThan(0);
    expect(r.usage.prompt_tokens).toBeGreaterThan(0);
    expect(r.usage.completion_tokens).toBeGreaterThan(0);
  }, 120_000);

  it('streaming chat: SSE chunks, finish reason and usage (include_usage injected)', async () => {
    const req: ChatRequest = { model: 'x', stream: true, max_tokens: 16, temperature: 0, messages: [{ role: 'user', content: 'Count: 1 2 3' }] };
    const up = buildChat(target(CHAT), req);
    expect(JSON.parse(up.body).stream_options).toEqual({ include_usage: true });
    const res = await fetch(up.url, { method: 'POST', headers: up.headers, body: up.body });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const tr = chatStream(target(CHAT), false);
    const dec = new SseDecoder();
    const chunks: ChatChunk[] = [];
    for await (const bytes of res.body as unknown as AsyncIterable<Uint8Array>) {
      for (const f of dec.push(bytes)) chunks.push(...tr.feed(f));
    }
    for (const f of dec.end()) chunks.push(...tr.feed(f));
    const text = chunks.map((c) => c.choices[0]?.delta.content ?? '').join('');
    expect(text.length).toBeGreaterThan(0);
    expect(tr.finish).not.toBeNull();
    expect(tr.outTokens).toBeGreaterThan(0);
    // The usage-only chunk we injected is hidden from a caller that did not ask.
    expect(chunks.every((c) => c.choices.length > 0)).toBe(true);
  }, 120_000);

  it('tool calls come back in the OpenAI shape', async () => {
    const up = buildChat(target(CHAT), {
      model: 'x',
      temperature: 0,
      max_tokens: 128,
      messages: [{ role: 'user', content: 'What is the weather in Paris? Use the tool.' }],
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'Current weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }],
    });
    const res = await fetch(up.url, { method: 'POST', headers: up.headers, body: up.body });
    expect(res.status).toBe(200);
    const r = parseChat(target(CHAT), await res.json());
    const msg = r.choices[0]!.message;
    // Small models may answer in text; when they call, the shape must be right.
    if (msg.tool_calls?.length) {
      expect(msg.tool_calls[0]!.function.name).toBe('get_weather');
      expect(() => JSON.parse(msg.tool_calls![0]!.function.arguments)).not.toThrow();
      expect(r.choices[0]!.finish_reason).toBe('tool_calls');
    } else {
      expect(typeof msg.content).toBe('string');
    }
  }, 120_000);

  it('embeddings', async () => {
    const [up] = buildEmbed(target(EMBED), { model: 'embed', input: ['hello', 'world'] });
    const res = await fetch(up!.url, { method: 'POST', headers: up!.headers, body: up!.body });
    expect(res.status).toBe(200);
    const r = parseEmbed(target(EMBED), [await res.json()], 2);
    expect(r.data).toHaveLength(2);
    expect(r.data[0]!.embedding.length).toBeGreaterThan(10);
  }, 120_000);
});
