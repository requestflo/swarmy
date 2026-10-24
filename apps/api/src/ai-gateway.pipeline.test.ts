/**
 * The whole gateway pipeline over HTTP (Hono app.request) against a scratch
 * SQLite control.db and a mock upstream: auth, alias fallbacks + retries,
 * key and app allowlists, ABAC `ai.use`, the prompt-size cap, metering,
 * streaming translation on both surfaces, native Anthropic passthrough, and
 * the per-route answer cache (same question, then similar via `embed`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'swarmy-ai-gw-'));
process.env.SWARMY_DB_PATH = join(dir, 'control.db');
process.env.SWARMY_TELEMETRY_DB_PATH = join(dir, 'telemetry.db');
process.env.SWARMY_SECRET_KEY ??= 'test-secret-key-for-the-ai-gateway-pipeline-0001';

const { prisma, ensureSchema, buildAdapter } = await import('@swarmy/db');
const { encryptSecret } = await import('@swarmy/core/crypto');
const { aiGatewayApp, configureUpstreamGuard, setRetryOptions } = await import('./ai-gateway');
const { aiCacheStats } = await import('@swarmy/core/views');

const ORG = 'org_ai';
const CACHE_ORG = 'org_cache';
const USER = 'user_member';
const sha = (k: string): string => createHash('sha256').update(k).digest('hex');
let upstream: ReturnType<typeof Bun.serve>;
const hits: string[] = [];

/** The mock embedder's vectors: two phrasings of one question sit close together. */
const VECTORS: Record<string, number[]> = {
  'What is the capital of France?': [1, 0, 0],
  'Which city is the capital of France?': [0.97, 0.24, 0],
  'Tell me a joke': [0, 0, 1],
};

const openAiReply = (model: string) => ({
  id: 'chatcmpl-mock',
  object: 'chat.completion',
  created: 1,
  model,
  choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 },
});

beforeAll(async () => {
  upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      hits.push(url.pathname);
      const body = (await req.json().catch(() => ({}))) as { model?: string; stream?: boolean };
      if (url.pathname.startsWith('/flaky/')) return new Response('overloaded internal-secret-body', { status: 503 });
      if (url.pathname.startsWith('/redir/')) return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
      if (url.pathname === '/anth/v1/messages') {
        return Response.json({
          id: 'msg_mock',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{ type: 'text', text: 'native pong' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 2 },
        });
      }
      if (url.pathname === '/ok/v1/embeddings') {
        const input = String((body as { input?: unknown }).input ?? '');
        return Response.json({ object: 'list', data: [{ object: 'embedding', index: 0, embedding: VECTORS[input] ?? [0, 1, 0] }], model: body.model, usage: { prompt_tokens: 3, total_tokens: 3 } });
      }
      if (url.pathname === '/ok/v1/chat/completions') {
        if (!body.stream) return Response.json(openAiReply(body.model ?? 'x'));
        const c = (delta: object, finish: string | null = null) =>
          `data: ${JSON.stringify({ id: 's', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        const sse =
          c({ role: 'assistant', content: 'po' }) +
          c({ content: 'ng' }, 'stop') +
          `data: ${JSON.stringify({ id: 's', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } })}\n\n` +
          'data: [DONE]\n\n';
        return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response('not found', { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${upstream.port}`;

  await ensureSchema(buildAdapter());
  await prisma.organization.create({ data: { id: ORG, name: 'AI', slug: 'ai' } });
  await prisma.user.create({ data: { id: USER, name: 'Mo', email: 'mo@example.com' } });
  await prisma.member.create({ data: { id: 'mem_1', organizationId: ORG, userId: USER, role: 'member' } });
  await prisma.aiProviderConfig.create({
    data: {
      orgId: ORG,
      providersJson: {
        providers: [
          { kind: 'custom', baseUrl: `${base}/flaky`, isDefault: true },
          { kind: 'vllm', baseUrl: `${base}/ok` },
          { kind: 'anthropic', baseUrl: `${base}/anth` },
        ],
        settings: { auditLog: true, cache: false, guardrails: { redactPii: true, maxPromptTokens: 1000 } },
        routes: {
          smart: { strategy: 'fallback', targets: [{ provider: 'custom', model: 'big' }, { provider: 'vllm', model: 'qwen' }] },
        },
        apps: { shop: { models: ['fast'] } },
      },
      configEnc: encryptSecret(JSON.stringify({ custom: 'k-custom', anthropic: 'sk-ant-mock' })),
    },
  });
  const key = (id: string, limitsJson: object, appRef: string | null = null) =>
    prisma.aiVirtualKey.create({ data: { id, orgId: ORG, name: id, keyHash: sha(`swk-ai-${id}`), appRef, limitsJson } });
  await key('open', { mintedBy: USER });
  await key('embedonly', { models: ['embed'] });
  await key('shopkey', {}, 'shop/web');
  await key('tiny', { maxPromptTokens: 5 });
  await key('free', {});
  // An org rule: members may not use paid models.
  await prisma.policy.create({
    data: {
      orgId: ORG,
      name: 'Members use free models only',
      effect: 'forbid',
      priority: 80,
      source: JSON.stringify({ roles: ['member'], actions: ['ai.use'], resourceTypes: ['aiModel'], resourceLabels: { 'swarmy.ai.cost': 'paid' } }),
    },
  });
  // A second org for the answer cache: its own routes, `embed` in-cluster.
  await prisma.organization.create({ data: { id: CACHE_ORG, name: 'Cache', slug: 'cache' } });
  await prisma.aiProviderConfig.create({
    data: {
      orgId: CACHE_ORG,
      providersJson: {
        providers: [{ kind: 'vllm', baseUrl: `${base}/ok`, isDefault: true }],
        routes: {
          cached: { strategy: 'fallback', targets: [{ provider: 'vllm', model: 'qwen' }] },
          exact: { strategy: 'fallback', targets: [{ provider: 'vllm', model: 'qwen' }] },
          embed: { strategy: 'fallback', targets: [{ provider: 'vllm', model: 'embedder' }] },
        },
        routeCache: { cached: { ttlSeconds: 600, similarity: 0.9 }, exact: { ttlSeconds: 600, similarity: null } },
      },
    },
  });
  for (const id of ['c1', 'c2']) {
    await prisma.aiVirtualKey.create({ data: { id, orgId: CACHE_ORG, name: id, keyHash: sha(`swk-ai-${id}`), limitsJson: {} } });
  }
  setRetryOptions({ retries: 2, baseDelayMs: 1, maxDelayMs: 2, sleep: async () => {} });
  // The mock upstream is on loopback, which the SSRF guard refuses by default.
  configureUpstreamGuard({ allowHosts: ['127.0.0.1'] });
});

afterAll(() => {
  upstream?.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const post = (path: string, key: string | null, body: unknown, headers: Record<string, string> = {}) =>
  aiGatewayApp.request(`/v1/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer swk-ai-${key}` } : {}), ...headers },
    body: JSON.stringify(body),
  });

const chat = (model: string, extra: object = {}) => ({ model, messages: [{ role: 'user', content: 'ping' }], ...extra });

describe('AI gateway pipeline', () => {
  it('401 without / with an unknown key', async () => {
    expect((await post('chat/completions', null, chat('smart'))).status).toBe(401);
    expect((await post('chat/completions', 'nope', chat('smart'))).status).toBe(401);
  });

  it('an alias with no configured target is not a model; an unknown id goes to the default provider', async () => {
    expect((await post('chat/completions', 'free', chat('embed'))).status).toBe(400);
    hits.length = 0;
    const res = await post('chat/completions', 'free', chat('some-unknown-model'));
    // default provider = custom (flaky): retried, then its status is the caller's
    expect(res.status).toBe(503);
    expect(hits).toHaveLength(3);
    // the member's key is refused before any upstream call (custom is a paid provider)
    hits.length = 0;
    expect((await post('chat/completions', 'open', chat('some-unknown-model'))).status).toBe(403);
    expect(hits).toHaveLength(0);
  });

  it('ABAC ai.use denies a paid alias for a member key; the app allowlist narrows an app key', async () => {
    hits.length = 0;
    // The member's key is denied on `smart` (it includes a paid provider).
    const denied = await post('chat/completions', 'open', chat('smart'));
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe('policy_denied');
    // A key with no minter (legacy/system) is governed by allowlists only.
    const res = await post('chat/completions', 'shopkey', chat('smart'));
    expect(res.status).toBe(403); // app allowlist is [fast]
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('model_not_allowed');
  });

  it('fallback end to end on an unrestricted key', async () => {
    hits.length = 0;
    const res = await post('chat/completions', 'free', chat('smart'), { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-swarmy-ai-provider')).toBe('vllm');
    expect(res.headers.get('x-swarmy-ai-attempts')).toBe('4');
    expect(res.headers.get('x-swarmy-ai-trace-id')).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(hits).toEqual(['/flaky/v1/chat/completions', '/flaky/v1/chat/completions', '/flaky/v1/chat/completions', '/ok/v1/chat/completions']);
    const j = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(j.choices[0]!.message.content).toBe('pong');
    await Bun.sleep(20);
    const usage = await prisma.aiUsage.findMany({ where: { keyId: 'free', model: 'qwen' } });
    expect(usage.map((u) => [u.provider, u.model, u.inTokens, u.outTokens, Number(u.costMicros), u.status])).toEqual([['vllm', 'qwen', 7, 1, 0, 'ok']]);
    const log = await prisma.aiRequestLog.findFirst({ where: { keyId: 'free' } });
    expect(log?.promptRedacted).toBe('ping');
  });

  it('member keys may use free in-cluster models (ABAC permit)', async () => {
    const res = await post('chat/completions', 'open', chat('vllm/qwen'));
    expect(res.status).toBe(200);
  });

  it('key allowlist refuses other models', async () => {
    const res = await post('chat/completions', 'embedonly', chat('vllm/qwen'));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('model_not_allowed');
  });

  it('prompt-size cap (the tighter of org and key)', async () => {
    const res = await post('chat/completions', 'tiny', chat('vllm/qwen', { messages: [{ role: 'user', content: 'x'.repeat(100) }] }));
    expect(res.status).toBe(413);
  });

  it('streaming chat: OpenAI chunks, no injected usage chunk, [DONE]', async () => {
    const res = await post('chat/completions', 'free', chat('vllm/qwen', { stream: true }));
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    const datas = text.split('\n\n').filter(Boolean).map((b) => b.replace(/^data: /, ''));
    expect(datas[datas.length - 1]).toBe('[DONE]');
    const chunks = datas.slice(0, -1).map((d) => JSON.parse(d) as { choices: Array<{ delta: { content?: string } }> });
    expect(chunks.map((c) => c.choices[0]?.delta.content ?? '').join('')).toBe('pong');
    expect(chunks.every((c) => c.choices.length > 0)).toBe(true);
  });

  it('/v1/messages to a non-Anthropic target: translated both ways, streaming too', async () => {
    const res = await post('messages', 'free', { model: 'vllm/qwen', max_tokens: 20, messages: [{ role: 'user', content: 'ping' }] });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { type: string; content: Array<{ text: string }>; usage: { input_tokens: number } };
    expect(j.type).toBe('message');
    expect(j.content[0]!.text).toBe('pong');
    const s = await post('messages', 'free', { model: 'vllm/qwen', max_tokens: 20, stream: true, messages: [{ role: 'user', content: 'ping' }] });
    const events = (await s.text()).split('\n\n').filter(Boolean).map((b) => b.split('\n')[0]!.replace('event: ', ''));
    expect(events[0]).toBe('message_start');
    expect(events).toContain('content_block_delta');
    expect(events.slice(-2)).toEqual(['message_delta', 'message_stop']);
  });

  it('/v1/messages to Anthropic: native passthrough (admin-free key, paid model)', async () => {
    const res = await post('messages', 'free', { model: 'claude-haiku-4-5', max_tokens: 20, messages: [{ role: 'user', content: 'ping' }] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { content: Array<{ text: string }> }).content[0]!.text).toBe('native pong');
    await Bun.sleep(20);
    const u = await prisma.aiUsage.findFirst({ where: { keyId: 'free', provider: 'anthropic' } });
    expect(Number(u?.costMicros)).toBe(15); // 5 in × $1 + 2 out × $5 per MTok
  });

  it('GET /v1/models lists only what the key may call', async () => {
    const res = await aiGatewayApp.request('/v1/models', { headers: { authorization: 'Bearer swk-ai-embedonly' } });
    const ids = ((await res.json()) as { data: Array<{ id: string }> }).data.map((d) => d.id);
    expect(ids).toEqual([]);
    const all = await aiGatewayApp.request('/v1/models', { headers: { authorization: 'Bearer swk-ai-free' } });
    expect(((await all.json()) as { data: Array<{ id: string }> }).data.map((d) => d.id)).toContain('smart');
  });
});

describe('AI gateway limits (default RPM, failed-key limiter)', () => {
  it('a key with no rpm of its own gets the default (SWARMY_AI_DEFAULT_RPM)', async () => {
    await prisma.aiVirtualKey.create({ data: { id: 'defaultrpm', orgId: ORG, name: 'd', keyHash: sha('swk-ai-defaultrpm'), limitsJson: {} } });
    const saved = process.env.SWARMY_AI_DEFAULT_RPM;
    process.env.SWARMY_AI_DEFAULT_RPM = '2';
    try {
      expect((await post('chat/completions', 'defaultrpm', chat('vllm/qwen'))).status).toBe(200);
      expect((await post('chat/completions', 'defaultrpm', chat('vllm/qwen'))).status).toBe(200);
      const res = await post('chat/completions', 'defaultrpm', chat('vllm/qwen'));
      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).toBe('60');
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('rate_limited');
    } finally {
      if (saved === undefined) delete process.env.SWARMY_AI_DEFAULT_RPM;
      else process.env.SWARMY_AI_DEFAULT_RPM = saved;
    }
  });

  it('an address that keeps presenting bad keys gets 429 before any lookup; others are unaffected', async () => {
    const from = (ip: string) => ({ 'x-swarmy-client-ip': ip });
    for (let i = 0; i < 20; i++) {
      expect((await post('chat/completions', `guess${i}`, chat('vllm/qwen'), from('203.0.113.9'))).status).toBe(401);
    }
    const blocked = await post('chat/completions', 'free', chat('vllm/qwen'), from('203.0.113.9'));
    expect(blocked.status).toBe(429);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe('auth_rate_limited');
    const models = await aiGatewayApp.request('/v1/models', { headers: { authorization: 'Bearer swk-ai-free', ...from('203.0.113.9') } });
    expect(models.status).toBe(429);
    expect((await post('chat/completions', 'free', chat('vllm/qwen'), from('203.0.113.10'))).status).toBe(200);
  });
});

describe('AI gateway hardening (security review H13/H14)', () => {
  it('refuses an oversized chunked body (no Content-Length) with 413 before auth', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (sent > 10 * 1024 * 1024) return ctrl.close();
        sent += chunk.length;
        ctrl.enqueue(chunk);
      },
    });
    const res = await aiGatewayApp.request('/v1/chat/completions', { method: 'POST', body, duplex: 'half' } as RequestInit);
    expect(res.status).toBe(413);
  });

  it('never reflects an upstream error body to the caller', async () => {
    const res = await post('chat/completions', 'free', chat('some-unknown-model'));
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).not.toContain('internal-secret-body');
    expect(text).toContain('HTTP 503');
  });

  it('refuses a loopback upstream that is not allowlisted, and never follows redirects', async () => {
    configureUpstreamGuard({ allowHosts: [] });
    try {
      hits.length = 0;
      const res = await post('chat/completions', 'free', chat('some-unknown-model'));
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('upstream URL refused');
      expect(hits).toHaveLength(0);
    } finally {
      configureUpstreamGuard({ allowHosts: ['127.0.0.1'] });
    }
    const cfg = await prisma.aiProviderConfig.findUniqueOrThrow({ where: { orgId: ORG } });
    const doc = cfg.providersJson as { providers: Array<{ kind: string; baseUrl: string }> };
    const original = doc.providers.map((p) => ({ ...p }));
    doc.providers = doc.providers.map((p) => (p.kind === 'custom' ? { ...p, baseUrl: p.baseUrl.replace('/flaky', '/redir') } : p));
    await prisma.aiProviderConfig.update({ where: { orgId: ORG }, data: { providersJson: doc as object } });
    try {
      const res = await post('chat/completions', 'free', chat('some-unknown-model'));
      expect(res.status).toBe(502);
      expect(await res.text()).toContain('redirect');
    } finally {
      await prisma.aiProviderConfig.update({ where: { orgId: ORG }, data: { providersJson: { ...doc, providers: original } as object } });
    }
  });
});

describe('answer cache: opt-in per route, per key', () => {
  const ask = (key: string, model: string, q: string, extra: object = {}) => post('chat/completions', key, { model, messages: [{ role: 'user', content: q }], ...extra });

  it('same question (normalised) and similar question (embed) answer without the model; other keys miss', async () => {
    hits.length = 0;
    const first = await ask('c1', 'cached', 'What is the capital of France?');
    expect(first.status).toBe(200);
    expect(first.headers.get('x-swarmy-ai-cache')).toBeNull();
    expect(hits).toEqual(['/ok/v1/embeddings', '/ok/v1/chat/completions']);

    hits.length = 0;
    const same = await ask('c1', 'cached', 'What is  the capital of France?  ');
    expect(same.headers.get('x-swarmy-ai-cache')).toBe('hit');
    expect(((await same.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content).toBe('pong');
    expect(hits).toEqual([]);

    const similar = await ask('c1', 'cached', 'Which city is the capital of France?');
    expect(similar.headers.get('x-swarmy-ai-cache')).toBe('similar');
    expect(Number(similar.headers.get('x-swarmy-ai-cache-score'))).toBeGreaterThan(0.9);
    expect(hits).toEqual(['/ok/v1/embeddings']);

    hits.length = 0;
    expect((await ask('c1', 'cached', 'Tell me a joke')).headers.get('x-swarmy-ai-cache')).toBeNull();
    expect((await ask('c2', 'cached', 'What is the capital of France?')).headers.get('x-swarmy-ai-cache')).toBeNull();
    expect((await ask('c1', 'cached', 'What is the capital of France?', { stream: true })).headers.get('x-swarmy-ai-cache')).toBeNull();
    expect(hits.filter((h) => h.endsWith('/chat/completions'))).toHaveLength(3);
  });

  it('a route without similarity never calls embed; a bare model id is never cached', async () => {
    hits.length = 0;
    await ask('c1', 'exact', 'What is the capital of France?');
    expect((await ask('c1', 'exact', 'Which city is the capital of France?')).headers.get('x-swarmy-ai-cache')).toBeNull();
    expect((await ask('c1', 'exact', 'What is the capital of France?')).headers.get('x-swarmy-ai-cache')).toBe('hit');
    await ask('c1', 'vllm/qwen', 'ping');
    expect((await ask('c1', 'vllm/qwen', 'ping')).headers.get('x-swarmy-ai-cache')).toBeNull();
    expect(hits).not.toContain('/ok/v1/embeddings');
  });

  it('hits are metered free, the embed calls are metered to the key, and the counters add up', async () => {
    await Bun.sleep(20);
    const rows = await prisma.aiUsage.findMany({ where: { orgId: CACHE_ORG, keyId: 'c1' }, orderBy: { at: 'asc' } });
    expect(rows.filter((r) => r.cacheHit).map((r) => [r.model, Number(r.costMicros)])).toEqual([['qwen', 0], ['qwen', 0], ['qwen', 0]]);
    expect(rows.filter((r) => r.model === 'embedder')).toHaveLength(3);
    const stats = aiCacheStats()!(CACHE_ORG).routes;
    expect(stats.map((r) => [r.route, r.lookups, r.sameHits, r.similarHits, r.entries])).toEqual([
      ['cached', 5, 1, 1, 3],
      ['exact', 3, 1, 0, 2],
    ]);
  });
});
