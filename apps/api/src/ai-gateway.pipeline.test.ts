/**
 * The whole gateway pipeline over HTTP (Hono app.request) against a scratch
 * SQLite control.db and a mock upstream: auth, alias fallbacks + retries,
 * key and app allowlists, ABAC `ai.use`, the prompt-size cap, metering,
 * streaming translation on both surfaces, native Anthropic passthrough.
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

const ORG = 'org_ai';
const USER = 'user_member';
const sha = (k: string): string => createHash('sha256').update(k).digest('hex');
let upstream: ReturnType<typeof Bun.serve>;
const hits: string[] = [];

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
