/**
 * Translation goldens per provider: request out, response in, streaming
 * chunks, tool calls — plus the reverse Anthropic-in path and embeddings.
 */
import { describe, expect, it } from 'bun:test';
import type { AiProviderKind } from '@swarmy/core/views';
import { buildChat, buildEmbed, chatStream, parseChat, parseEmbed, type Target } from './adapters';
import { anthropicToOpenAIRequest, openAIToAnthropicResponse, OpenAIToAnthropicStream } from './anthropic';
import { AwsEventStreamDecoder, encodeAwsEvent, SseDecoder } from './framing';
import { signV4 } from './sigv4';
import type { ChatChunk, ChatRequest } from './wire';

const t = (provider: AiProviderKind, model: string, over: Partial<Target['descriptor']> = {}, apiKey: string | null = 'KEY'): Target => ({
  provider,
  model,
  apiKey,
  descriptor: { kind: provider, baseUrl: null, isDefault: false, ...over },
});

/** A tool-using conversation every adapter must translate. */
const TOOL_REQ: ChatRequest = {
  model: 'smart',
  max_tokens: 256,
  temperature: 0.2,
  stop: ['END'],
  messages: [
    { role: 'system', content: 'Be terse.' },
    { role: 'user', content: 'Weather in Paris?' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '{"temp_c":18}' },
  ],
  tools: [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Current weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false },
      },
    },
  ],
  tool_choice: 'auto',
};

const body = (u: { body: string }): Record<string, unknown> => JSON.parse(u.body) as Record<string, unknown>;

/** Feed SSE text through the provider's stream translator. */
function runSse(target: Target, sse: string, wantUsage = true): { chunks: ChatChunk[]; tr: ReturnType<typeof chatStream> } {
  const tr = chatStream(target, wantUsage);
  const dec = new SseDecoder();
  const chunks: ChatChunk[] = [];
  // Split mid-event to prove the decoder is incremental.
  const mid = Math.floor(sse.length / 2);
  for (const part of [sse.slice(0, mid), sse.slice(mid)]) for (const f of dec.push(part)) chunks.push(...tr.feed(f));
  for (const f of dec.end()) chunks.push(...tr.feed(f));
  chunks.push(...tr.end());
  return { chunks, tr };
}

const content = (chunks: ChatChunk[]): string => chunks.map((c) => c.choices[0]?.delta.content ?? '').join('');
const toolArgs = (chunks: ChatChunk[]): string =>
  chunks.flatMap((c) => c.choices[0]?.delta.tool_calls ?? []).map((d) => d.function.arguments ?? '').join('');
const toolNames = (chunks: ChatChunk[]): string[] =>
  chunks.flatMap((c) => c.choices[0]?.delta.tool_calls ?? []).filter((d) => d.function.name).map((d) => d.function.name!);

// ── OpenAI-shaped providers ──────────────────────────────────────────────────

describe('OpenAI-shaped providers (openai, azure, mistral, groq, openrouter, ollama, vllm, custom)', () => {
  it('openai: passthrough with the target model; include_usage injected on streams', () => {
    const up = buildChat(t('openai', 'gpt-5-mini'), { ...TOOL_REQ, stream: true });
    expect(up.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(up.headers.authorization).toBe('Bearer KEY');
    const b = body(up);
    expect(b.model).toBe('gpt-5-mini');
    expect(b.stream_options).toEqual({ include_usage: true });
    expect(b.tools).toEqual(TOOL_REQ.tools);
    expect(b.messages).toEqual(TOOL_REQ.messages);
  });

  it('azure: deployment URL + api-version + api-key header, no model in body', () => {
    const up = buildChat(t('azure', 'gpt-4o', { baseUrl: 'https://acme.openai.azure.com/', deployments: { 'gpt-4o': 'prod-4o' } }), TOOL_REQ);
    expect(up.url).toBe('https://acme.openai.azure.com/openai/deployments/prod-4o/chat/completions?api-version=2024-10-21');
    expect(up.headers['api-key']).toBe('KEY');
    expect(up.headers.authorization).toBeUndefined();
    expect(body(up).model).toBeUndefined();
  });

  it('groq / openrouter / mistral / in-cluster base URLs', () => {
    expect(buildChat(t('groq', 'llama-3.1-8b-instant'), TOOL_REQ).url).toBe('https://api.groq.com/openai/v1/chat/completions');
    const or = buildChat(t('openrouter', 'anthropic/claude-sonnet-4.5'), TOOL_REQ);
    expect(or.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(or.headers['x-title']).toBe('swarmy');
    const mi = buildChat(t('mistral', 'mistral-small-latest'), { ...TOOL_REQ, stream: true });
    expect(mi.url).toBe('https://api.mistral.ai/v1/chat/completions');
    expect(body(mi).stream_options).toBeUndefined(); // mistral reports usage without it
    const ol = buildChat(t('ollama', 'llama3.2:3b', { baseUrl: 'http://llm_ollama:11434' }, null), TOOL_REQ);
    expect(ol.url).toBe('http://llm_ollama:11434/v1/chat/completions');
    expect(ol.headers.authorization).toBeUndefined();
    // A pasted `/v1` root is not doubled.
    expect(buildChat(t('vllm', 'qwen', { baseUrl: 'http://gpu_vllm:8000/v1' }, null), TOOL_REQ).url).toBe('http://gpu_vllm:8000/v1/chat/completions');
  });

  it('parses a tool-call response', () => {
    const r = parseChat(t('groq', 'llama-3.1-8b-instant'), {
      id: 'x',
      created: 1,
      model: 'llama-3.1-8b-instant',
      choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'get_weather', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
    });
    expect(r.choices[0]!.message.tool_calls![0]!.function.name).toBe('get_weather');
    expect(r.usage).toEqual({ prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 });
  });

  it('stream: forwards chunks, reads usage, hides an injected usage-only chunk', () => {
    const sse = [
      'data: {"id":"a","object":"chat.completion.chunk","created":1,"model":"gpt-5-mini","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}',
      '',
      'data: {"id":"a","object":"chat.completion.chunk","created":1,"model":"gpt-5-mini","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":"stop"}]}',
      '',
      'data: {"id":"a","object":"chat.completion.chunk","created":1,"model":"gpt-5-mini","choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2,"total_tokens":11}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const hidden = runSse(t('openai', 'gpt-5-mini'), sse, false);
    expect(content(hidden.chunks)).toBe('Hello');
    expect(hidden.chunks).toHaveLength(2);
    expect([hidden.tr.inTokens, hidden.tr.outTokens, hidden.tr.finish]).toEqual([9, 2, 'stop']);
    expect(runSse(t('openai', 'gpt-5-mini'), sse, true).chunks).toHaveLength(3);
  });
});

// ── Anthropic ────────────────────────────────────────────────────────────────

describe('Anthropic', () => {
  const target = t('anthropic', 'claude-sonnet-5');

  it('request: system lifted, tool_use + tool_result blocks, tools, choice, stop', () => {
    const up = buildChat(target, TOOL_REQ);
    expect(up.url).toBe('https://api.anthropic.com/v1/messages');
    expect(up.headers['x-api-key']).toBe('KEY');
    expect(up.headers['anthropic-version']).toBe('2023-06-01');
    expect(body(up)).toEqual({
      model: 'claude-sonnet-5',
      max_tokens: 256,
      system: 'Be terse.',
      temperature: 0.2,
      stop_sequences: ['END'],
      messages: [
        { role: 'user', content: 'Weather in Paris?' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{"temp_c":18}' }] },
      ],
      tools: [
        {
          name: 'get_weather',
          description: 'Current weather',
          input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false },
        },
      ],
      tool_choice: { type: 'auto' },
    });
  });

  it('request: max_tokens defaults (required upstream); images become blocks', () => {
    const b = body(
      buildChat(target, {
        model: 'x',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'what?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }],
      }),
    );
    expect(b.max_tokens).toBe(4096);
    expect((b.messages as Array<{ content: unknown }>)[0]!.content).toEqual([
      { type: 'text', text: 'what?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ]);
  });

  it('response: text + tool_use → OpenAI message; cache tokens count as input', () => {
    const r = parseChat(target, {
      id: 'msg_1',
      model: 'claude-sonnet-5',
      content: [
        { type: 'text', text: 'Checking.' },
        { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 7 },
    });
    expect(r.choices[0]).toEqual({
      index: 0,
      message: {
        role: 'assistant',
        content: 'Checking.',
        tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }],
      },
      finish_reason: 'tool_calls',
    });
    expect(r.usage).toEqual({ prompt_tokens: 15, completion_tokens: 7, total_tokens: 22 });
  });

  it('stream: text deltas, a tool call with input_json_delta, finish + usage', () => {
    const ev = (name: string, data: unknown): string => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    const sse = [
      ev('message_start', { type: 'message_start', message: { id: 'msg_9', model: 'claude-sonnet-5', usage: { input_tokens: 25, output_tokens: 1 } } }),
      ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me ' } }),
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'check.' } }),
      ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
      ev('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_2', name: 'get_weather', input: {} } }),
      ev('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"city":' } }),
      ev('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"Paris"}' } }),
      ev('content_block_stop', { type: 'content_block_stop', index: 1 }),
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 42 } }),
      ev('message_stop', { type: 'message_stop' }),
    ].join('');
    const { chunks, tr } = runSse(target, sse);
    expect(chunks[0]!.choices[0]!.delta).toEqual({ role: 'assistant', content: '' });
    expect(chunks[0]!.id).toBe('msg_9');
    expect(content(chunks)).toBe('Let me check.');
    expect(toolNames(chunks)).toEqual(['get_weather']);
    expect(toolArgs(chunks)).toBe('{"city":"Paris"}');
    expect(chunks.flatMap((c) => c.choices[0]?.delta.tool_calls ?? []).every((d) => d.index === 0)).toBe(true);
    expect(chunks.find((c) => c.choices[0]?.finish_reason)?.choices[0]!.finish_reason).toBe('tool_calls');
    expect(chunks[chunks.length - 1]!.usage).toEqual({ prompt_tokens: 25, completion_tokens: 42, total_tokens: 67 });
    expect([tr.inTokens, tr.outTokens]).toEqual([25, 42]);
  });

  it('embeddings are refused with a clear message', () => {
    expect(() => buildEmbed(target, { model: 'x', input: 'hi' })).toThrow(/no embeddings/);
  });
});

// ── Anthropic IN (native /v1/messages) → any OpenAI-shaped upstream ─────────

describe('/v1/messages translated for non-Anthropic targets', () => {
  const msgBody = {
    model: 'smart',
    max_tokens: 100,
    system: 'Be terse.',
    messages: [
      { role: 'user', content: 'Weather in Paris?' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '18C' }, { type: 'text', text: 'And tomorrow?' }] },
    ],
    tools: [{ name: 'get_weather', description: 'w', input_schema: { type: 'object', properties: {} } }],
    tool_choice: { type: 'any' },
  };

  it('request golden', () => {
    expect(anthropicToOpenAIRequest(msgBody, 'gpt-5-mini')).toEqual({
      model: 'gpt-5-mini',
      max_tokens: 100,
      messages: [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'Weather in Paris?' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
        { role: 'tool', tool_call_id: 'toolu_1', content: '18C' },
        { role: 'user', content: 'And tomorrow?' },
      ],
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'w', parameters: { type: 'object', properties: {} } } }],
      tool_choice: 'required',
    });
  });

  it('response golden', () => {
    const r = openAIToAnthropicResponse(
      {
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-5-mini',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Sure.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      },
      'smart',
    );
    expect(r).toEqual({
      id: 'msg_chatcmpl-1',
      type: 'message',
      role: 'assistant',
      model: 'gpt-5-mini',
      content: [
        { type: 'text', text: 'Sure.' },
        { type: 'tool_use', id: 'c1', name: 'get_weather', input: { city: 'Paris' } },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 4 },
    });
  });

  it('stream: OpenAI chunks → Anthropic event sequence', () => {
    const s = new OpenAIToAnthropicStream('smart');
    const c = (delta: ChatChunk['choices'][number]['delta'], finish: ChatChunk['choices'][number]['finish_reason'] = null): ChatChunk => ({
      id: 'a',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'm',
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    const out = [
      ...s.feed(c({ role: 'assistant', content: 'Hi' })),
      ...s.feed(c({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"a"' } }] })),
      ...s.feed(c({ tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }, 'tool_calls')),
      ...s.feed({ id: 'a', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [], usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 } }),
      ...s.end(),
    ];
    expect(out.map((e) => e.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    expect(out[4]!.data).toEqual({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'c1', name: 'get_weather', input: {} } });
    expect(out[8]!.data).toEqual({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { input_tokens: 5, output_tokens: 6 } });
  });
});

// ── Gemini ───────────────────────────────────────────────────────────────────

describe('Gemini', () => {
  const target = t('gemini', 'gemini-2.5-flash');

  it('request: systemInstruction, model/user roles, functionCall + named functionResponse, sanitised schema', () => {
    const up = buildChat(target, TOOL_REQ);
    expect(up.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    expect(up.headers['x-goog-api-key']).toBe('KEY');
    expect(body(up)).toEqual({
      contents: [
        { role: 'user', parts: [{ text: 'Weather in Paris?' }] },
        { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { temp_c: 18 } } }] },
      ],
      systemInstruction: { parts: [{ text: 'Be terse.' }] },
      generationConfig: { maxOutputTokens: 256, temperature: 0.2, stopSequences: ['END'] },
      tools: [
        {
          functionDeclarations: [
            { name: 'get_weather', description: 'Current weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
          ],
        },
      ],
    });
    expect(buildChat(target, { ...TOOL_REQ, stream: true }).url).toContain(':streamGenerateContent?alt=sse');
  });

  it('response: function call → tool_calls; thoughts count as output', () => {
    const r = parseChat(target, {
      candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }, { functionCall: { name: 'get_weather', args: { city: 'Paris' } } }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 4, thoughtsTokenCount: 6 },
      modelVersion: 'gemini-2.5-flash',
    });
    expect(r.choices[0]!.message.content).toBe('ok');
    expect(r.choices[0]!.message.tool_calls![0]!.function).toEqual({ name: 'get_weather', arguments: '{"city":"Paris"}' });
    expect(r.choices[0]!.finish_reason).toBe('tool_calls');
    expect(r.usage).toEqual({ prompt_tokens: 11, completion_tokens: 10, total_tokens: 21 });
  });

  it('stream: text chunks, a whole function call, finish, cumulative usage', () => {
    const d = (o: unknown): string => `data: ${JSON.stringify(o)}\r\n\r\n`;
    const sse =
      d({ candidates: [{ content: { parts: [{ text: 'Hel' }] } }], usageMetadata: { promptTokenCount: 8 } }) +
      d({ candidates: [{ content: { parts: [{ text: 'lo' }] } }] }) +
      d({ candidates: [{ content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 5 } });
    const { chunks, tr } = runSse(target, sse);
    expect(content(chunks)).toBe('Hello');
    expect(toolNames(chunks)).toEqual(['get_weather']);
    expect(toolArgs(chunks)).toBe('{"city":"Paris"}');
    expect(tr.finish).toBe('tool_calls');
    expect([tr.inTokens, tr.outTokens]).toEqual([8, 5]);
  });

  it('embeddings: batchEmbedContents both ways', () => {
    const [up] = buildEmbed(t('gemini', 'gemini-embedding-001'), { model: 'embed', input: ['a', 'b'], dimensions: 256 });
    expect(up!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents');
    expect(body(up!)).toEqual({
      requests: [
        { model: 'models/gemini-embedding-001', content: { parts: [{ text: 'a' }] }, outputDimensionality: 256 },
        { model: 'models/gemini-embedding-001', content: { parts: [{ text: 'b' }] }, outputDimensionality: 256 },
      ],
    });
    const r = parseEmbed(t('gemini', 'gemini-embedding-001'), [{ embeddings: [{ values: [1, 2] }, { values: [3, 4] }] }], 2);
    expect(r.data).toEqual([
      { object: 'embedding', index: 0, embedding: [1, 2] },
      { object: 'embedding', index: 1, embedding: [3, 4] },
    ]);
    expect(r.usage.prompt_tokens).toBe(2);
  });
});

// ── Bedrock ──────────────────────────────────────────────────────────────────

describe('AWS Bedrock (Converse + SigV4)', () => {
  const target = t('bedrock', 'amazon.nova-lite-v1:0', { region: 'eu-west-1' }, 'AKIDEXAMPLE:wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY');
  const now = new Date('2026-09-24T12:00:00Z');

  it('request: converse body, regional URL, SigV4-signed', () => {
    const up = buildChat(target, TOOL_REQ, now);
    expect(up.url).toBe('https://bedrock-runtime.eu-west-1.amazonaws.com/model/amazon.nova-lite-v1%3A0/converse');
    expect(body(up)).toEqual({
      messages: [
        { role: 'user', content: [{ text: 'Weather in Paris?' }] },
        { role: 'assistant', content: [{ toolUse: { toolUseId: 'call_1', name: 'get_weather', input: { city: 'Paris' } } }] },
        { role: 'user', content: [{ toolResult: { toolUseId: 'call_1', content: [{ text: '{"temp_c":18}' }] } }] },
      ],
      system: [{ text: 'Be terse.' }],
      inferenceConfig: { maxTokens: 256, temperature: 0.2, stopSequences: ['END'] },
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: 'get_weather',
              description: 'Current weather',
              inputSchema: { json: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false } },
            },
          },
        ],
        toolChoice: { auto: {} },
      },
    });
    expect(up.headers['x-amz-date']).toBe('20260924T120000Z');
    expect(up.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260924\/eu-west-1\/bedrock\/aws4_request, SignedHeaders=accept;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    // Deterministic for a fixed clock.
    expect(buildChat(target, TOOL_REQ, now).headers.authorization).toBe(up.headers.authorization!);
  });

  it('a Bedrock API key (no colon) is sent as a bearer token', () => {
    const up = buildChat({ ...target, apiKey: 'ABSKbedrockapikey' }, TOOL_REQ);
    expect(up.headers.authorization).toBe('Bearer ABSKbedrockapikey');
  });

  it('response: toolUse → tool_calls, usage', () => {
    const r = parseChat(target, {
      output: { message: { role: 'assistant', content: [{ text: 'ok' }, { toolUse: { toolUseId: 't1', name: 'get_weather', input: { city: 'Paris' } } }] } },
      stopReason: 'tool_use',
      usage: { inputTokens: 20, outputTokens: 9 },
    });
    expect(r.choices[0]!.message.tool_calls).toEqual([{ id: 't1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }]);
    expect(r.choices[0]!.finish_reason).toBe('tool_calls');
    expect(r.usage.total_tokens).toBe(29);
  });

  it('stream: AWS event-stream frames → chunks (split across reads)', () => {
    const e = (type: string, payload: unknown): Uint8Array => encodeAwsEvent({ ':event-type': type, ':message-type': 'event', ':content-type': 'application/json' }, JSON.stringify(payload));
    const frames = [
      e('messageStart', { role: 'assistant' }),
      e('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'Hi ' } }),
      e('contentBlockStart', { contentBlockIndex: 1, start: { toolUse: { toolUseId: 't9', name: 'get_weather' } } }),
      e('contentBlockDelta', { contentBlockIndex: 1, delta: { toolUse: { input: '{"city":"Paris"}' } } }),
      e('contentBlockStop', { contentBlockIndex: 1 }),
      e('messageStop', { stopReason: 'tool_use' }),
      e('metadata', { usage: { inputTokens: 14, outputTokens: 6 } }),
    ];
    const all = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
    let o = 0;
    for (const f of frames) {
      all.set(f, o);
      o += f.length;
    }
    const dec = new AwsEventStreamDecoder();
    const tr = chatStream(target, true);
    const chunks: ChatChunk[] = [];
    for (const part of [all.slice(0, 37), all.slice(37, 200), all.slice(200)]) {
      for (const ev of dec.push(part)) chunks.push(...tr.feed({ event: ev.headers[':event-type'] ?? null, data: new TextDecoder().decode(ev.payload) }));
    }
    chunks.push(...tr.end());
    expect(content(chunks)).toBe('Hi ');
    expect(toolNames(chunks)).toEqual(['get_weather']);
    expect(toolArgs(chunks)).toBe('{"city":"Paris"}');
    expect(tr.finish).toBe('tool_calls');
    expect(chunks[chunks.length - 1]!.usage).toEqual({ prompt_tokens: 14, completion_tokens: 6, total_tokens: 20 });
  });

  it('embeddings: one Titan invoke per input', () => {
    const emb = t('bedrock', 'amazon.titan-embed-text-v2:0', { region: 'us-east-1' }, 'AK:SK');
    const ups = buildEmbed(emb, { model: 'embed', input: ['a', 'b'] }, 0, now);
    expect(ups.map((u) => u.url)).toEqual([
      'https://bedrock-runtime.us-east-1.amazonaws.com/model/amazon.titan-embed-text-v2%3A0/invoke',
      'https://bedrock-runtime.us-east-1.amazonaws.com/model/amazon.titan-embed-text-v2%3A0/invoke',
    ]);
    expect(body(ups[1]!)).toEqual({ inputText: 'b' });
    const r = parseEmbed(emb, [{ embedding: [0.1], inputTextTokenCount: 1 }, { embedding: [0.2], inputTextTokenCount: 2 }], 0);
    expect(r.data.map((d) => d.embedding)).toEqual([[0.1], [0.2]]);
    expect(r.usage.prompt_tokens).toBe(3);
  });
});

describe('SigV4 — AWS test-suite vector (get-vanilla)', () => {
  it('matches the published signature', () => {
    const h = signV4({
      method: 'GET',
      url: 'https://example.amazonaws.com/',
      headers: {},
      body: '',
      region: 'us-east-1',
      service: 'service',
      creds: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
      now: new Date('2015-08-30T12:36:00Z'),
      contentSha256Header: false,
    });
    expect(h.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
  });
});

describe('embeddings passthrough (OpenAI-shaped)', () => {
  it('openai + azure', () => {
    const [o] = buildEmbed(t('openai', 'text-embedding-3-small'), { model: 'embed', input: 'x' });
    expect(o!.url).toBe('https://api.openai.com/v1/embeddings');
    expect(body(o!)).toEqual({ model: 'text-embedding-3-small', input: 'x' });
    const [a] = buildEmbed(t('azure', 'text-embedding-3-small', { baseUrl: 'https://acme.openai.azure.com', apiVersion: '2025-01-01' }), { model: 'embed', input: 'x' });
    expect(a!.url).toBe('https://acme.openai.azure.com/openai/deployments/text-embedding-3-small/embeddings?api-version=2025-01-01');
  });
});
