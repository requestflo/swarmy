import { describe, expect, it } from 'bun:test';
import {
  aiModelResource,
  costMicros,
  discoverInClusterModels,
  effectiveRoutes,
  estimatePromptTokens,
  modelAllowed,
  orderTargets,
  parseConfigDoc,
  parseKeyPolicy,
  probeModel,
  redactPii,
  resolveModel,
  serializeConfigDoc,
  withDiscovered,
  type AiProviderDescriptor,
  type AiProviderKind,
} from './ai-gateway';

const p = (kind: AiProviderKind, over: Partial<AiProviderDescriptor> = {}): AiProviderDescriptor => ({ kind, baseUrl: null, isDefault: false, ...over });
const doc = (providers: AiProviderDescriptor[], routes = {}) => ({ providers, routes });

describe('resolveModel — aliases, provider/model, prefixes, default', () => {
  const all = doc([p('anthropic'), p('openai'), p('gemini'), p('groq'), p('ollama', { baseUrl: 'http://ollama:11434' })]);

  it('default aliases resolve to every configured provider, first preference first (fallback chain)', () => {
    const r = resolveModel('smart', all)!;
    expect(r.alias).toBe('smart');
    expect(r.strategy).toBe('fallback');
    expect(r.targets.map((t) => `${t.provider}/${t.model}`)).toEqual([
      'anthropic/claude-sonnet-5',
      'openai/gpt-5',
      'gemini/gemini-2.5-pro',
      'groq/llama-3.3-70b-versatile',
    ]);
    expect(resolveModel('embed', all)!.targets[0]).toEqual({ provider: 'openai', model: 'text-embedding-3-small' });
  });

  it('an org route overrides the default alias', () => {
    const r = resolveModel('fast', doc([p('openai'), p('groq')], { fast: { strategy: 'balance', targets: [{ provider: 'groq', model: 'llama-3.1-8b-instant', weight: 3 }, { provider: 'openai', model: 'gpt-5-nano' }] } }))!;
    expect(r.strategy).toBe('balance');
    expect(r.targets).toHaveLength(2);
  });

  it('drops alias targets whose provider is not configured; null when none remain', () => {
    expect(resolveModel('embed', doc([p('anthropic')]))).toBeNull();
  });

  it('provider/model picks that provider (slashes after the first stay in the model)', () => {
    expect(resolveModel('ollama/llama3.2:3b', all)!.targets).toEqual([{ provider: 'ollama', model: 'llama3.2:3b' }]);
    const or = resolveModel('openrouter/anthropic/claude-sonnet-4.5', doc([p('openrouter')]))!;
    expect(or.targets).toEqual([{ provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5' }]);
  });

  it('routes model ids by catalogue and prefix', () => {
    expect(resolveModel('claude-haiku-4-5', all)!.targets[0]!.provider).toBe('anthropic');
    expect(resolveModel('gpt-5-mini', all)!.targets[0]!.provider).toBe('openai');
    expect(resolveModel('o4-mini', all)!.targets[0]!.provider).toBe('openai');
    expect(resolveModel('gemini-2.5-flash', all)!.targets[0]!.provider).toBe('gemini');
    expect(resolveModel('llama-3.1-8b-instant', all)!.targets[0]!.provider).toBe('groq');
  });

  it('o-series routing does not swallow ollama-ish names; unknown ids go to the default', () => {
    const d = doc([p('openai'), p('custom', { baseUrl: 'https://llm', isDefault: true })]);
    expect(resolveModel('ollama-llama3', d)!.targets[0]!.provider).toBe('custom');
    expect(resolveModel('mystery', d)!.targets[0]!.provider).toBe('custom');
  });

  it('GPT ids reach Azure when only Azure hosts them', () => {
    expect(resolveModel('gpt-4o', doc([p('azure', { baseUrl: 'https://x.openai.azure.com' })]))!.targets[0]!.provider).toBe('azure');
  });
});

describe('orderTargets — load balancing', () => {
  const r = { strategy: 'balance' as const, targets: [{ provider: 'openai' as const, model: 'a', weight: 1 }, { provider: 'groq' as const, model: 'b', weight: 3 }] };
  it('weighted first pick; the rest stay as fallbacks', () => {
    expect(orderTargets(r, () => 0.1).map((t) => t.model)).toEqual(['a', 'b']);
    expect(orderTargets(r, () => 0.9).map((t) => t.model)).toEqual(['b', 'a']);
  });
  it('fallback keeps the declared order', () => {
    expect(orderTargets({ ...r, strategy: 'fallback' }, () => 0.9).map((t) => t.model)).toEqual(['a', 'b']);
  });
});

describe('modelAllowed — key + app allowlists', () => {
  const d = doc([p('anthropic'), p('openai'), p('groq')]);
  const smart = resolveModel('smart', d)!;
  const mini = resolveModel('gpt-5-mini', d)!;
  const groq = resolveModel('groq/llama-3.1-8b-instant', d)!;

  it('null lists are unrestricted', () => {
    expect(modelAllowed(smart, [null, undefined])).toBe(true);
  });
  it('matches alias names, ids, provider/model and provider/*', () => {
    expect(modelAllowed(smart, [['smart']])).toBe(true);
    expect(modelAllowed(mini, [['gpt-5-mini']])).toBe(true);
    expect(modelAllowed(mini, [['openai/gpt-5-mini']])).toBe(true);
    expect(modelAllowed(groq, [['groq/*']])).toBe(true);
    expect(modelAllowed(mini, [['groq/*']])).toBe(false);
    expect(modelAllowed(smart, [['*']])).toBe(true);
  });
  it('an alias allowlist does not open the underlying models by id', () => {
    expect(modelAllowed(mini, [['smart']])).toBe(false);
  });
  it('every level must allow (key AND app)', () => {
    expect(modelAllowed(smart, [['smart', 'embed'], ['embed']])).toBe(false);
    expect(modelAllowed(smart, [['smart'], ['smart', 'fast']])).toBe(true);
  });
  it('a multi-provider alias is not matched by one provider wildcard', () => {
    expect(modelAllowed(smart, [['openai/*']])).toBe(false);
  });
});

describe('aiModelResource — ABAC resource for ai.use', () => {
  it('names the model with provider/alias/cost labels', () => {
    const d = doc([p('openai'), p('ollama', { baseUrl: 'http://o:11434' })]);
    expect(aiModelResource('o1', resolveModel('smart', d)!)).toEqual({
      type: 'aiModel',
      id: 'smart',
      orgId: 'o1',
      labels: { 'swarmy.ai.provider': 'openai', 'swarmy.ai.alias': 'smart', 'swarmy.ai.cost': 'paid' },
    });
    expect(aiModelResource('o1', resolveModel('ollama/llama3.2:3b', d)!).labels['swarmy.ai.cost']).toBe('free');
  });
});

describe('price table', () => {
  it('prices exact catalogue rows ($/MTok == µ$/token)', () => {
    expect(costMicros('claude-haiku-4-5', 1000, 1000)).toBe(6000);
    expect(costMicros('claude-opus-4-8', 1_000_000, 0)).toBe(5_000_000);
    expect(costMicros('claude-fable-5', 1_000_000, 1_000_000)).toBe(60_000_000);
    expect(costMicros('claude-sonnet-5', 1_000_000, 0)).toBe(2_000_000);
    expect(costMicros('gpt-4o-mini', 1_000_000, 0)).toBe(150_000);
    expect(costMicros('text-embedding-3-small', 1_000_000, 0)).toBe(20_000);
    expect(costMicros('gemini-2.5-flash', 1_000_000, 1_000_000)).toBe(2_800_000);
  });
  it('normalises Bedrock and OpenRouter ids to the vendor rate', () => {
    expect(costMicros('us.anthropic.claude-haiku-4-5-20251001-v1:0', 1_000_000, 0)).toBe(1_000_000);
    expect(costMicros('anthropic/claude-sonnet-4.5', 1_000_000, 0, 'openrouter')).toBe(3_000_000);
  });
  it('in-cluster engines cost nothing; unknown models use the default rate', () => {
    expect(costMicros('llama3.2:3b', 1e6, 1e6, 'ollama')).toBe(0);
    expect(costMicros('mystery-model', 1_000_000, 1_000_000)).toBe(10_000_000);
  });
  it('the Test button pings the cheapest chat model', () => {
    expect(probeModel('anthropic')).toBe('claude-haiku-4-5');
    expect(probeModel('bedrock')).toBe('amazon.nova-micro-v1:0');
  });
});

describe('config + key policy codecs', () => {
  it('parses routes, apps and guardrails; drops garbage', () => {
    const d = parseConfigDoc({
      providers: [{ kind: 'bedrock', region: 'eu-west-1' }, { kind: 'azure', baseUrl: 'https://x.openai.azure.com/', apiVersion: '2024-10-21', deployments: { 'gpt-4o': 'prod-4o' } }],
      settings: { auditLog: true, guardrails: { redactPii: false, maxPromptTokens: 8000 } },
      routes: { fast: { strategy: 'balance', targets: [{ provider: 'groq', model: 'x' }, { provider: 'nope', model: 'y' }] }, 'bad name!': { targets: [] } },
      apps: { shop: { models: ['smart', 3] } },
    });
    expect(d.providers[0]).toEqual({ kind: 'bedrock', baseUrl: null, isDefault: false, region: 'eu-west-1' });
    expect(d.providers[1]!.deployments).toEqual({ 'gpt-4o': 'prod-4o' });
    expect(d.settings).toEqual({ auditLog: true, cache: false, guardrails: { redactPii: false, maxPromptTokens: 8000 } });
    expect(d.routes).toEqual({ fast: { strategy: 'balance', targets: [{ provider: 'groq', model: 'x' }] } });
    expect(d.apps).toEqual({ shop: { models: ['smart'] } });
  });

  it('serialises without discovered providers', () => {
    const d = parseConfigDoc({ providers: [{ kind: 'openai' }] });
    d.providers = withDiscovered(d.providers, [{ kind: 'ollama', service: 'llm_ollama', stack: 'llm', port: 11434, baseUrl: 'http://llm_ollama:11434' }]);
    expect(d.providers.map((x) => x.kind)).toEqual(['openai', 'ollama']);
    expect((serializeConfigDoc(d).providers as unknown[]).length).toBe(1);
  });

  it('key policy: allowlist, prompt cap, app-scoped budget, minter', () => {
    expect(parseKeyPolicy({ rpm: 10.7, dailyBudgetMicros: 5e6, models: ['smart', ''], maxPromptTokens: 4000, budgetScope: 'app', mintedBy: 'u1' })).toEqual({
      rpm: 10,
      dailyBudgetMicros: 5e6,
      budgetScope: 'app',
      models: ['smart'],
      maxPromptTokens: 4000,
      mintedBy: 'u1',
    });
    expect(parseKeyPolicy(null)).toEqual({ rpm: null, dailyBudgetMicros: null, budgetScope: 'key', models: null, maxPromptTokens: null, mintedBy: null });
  });

  it('effective routes include only aliases with a configured provider', () => {
    expect(Object.keys(effectiveRoutes({ routes: {} }, ['anthropic']))).toEqual(['fast', 'smart']);
  });
});

describe('in-cluster discovery (Ollama / vLLM templates)', () => {
  it('finds engines by image or label, first per kind', () => {
    const found = discoverInClusterModels([
      { name: 'llm_ollama', image: 'ollama/ollama:0.34.4@sha256:abc', stack: 'llm' },
      { name: 'b_ollama', image: 'ollama/ollama:latest', stack: 'b' },
      { name: 'gpu_vllm', image: 'vllm/vllm-openai:v0.11.0', stack: 'gpu' },
      { name: 'x_custom', image: 'ghcr.io/me/tgi:1', labels: { 'swarmy.ai.provider': 'vllm', 'swarmy.ai.port': '8080' } },
      { name: 'web', image: 'nginx:1' },
    ]);
    expect(found).toEqual([
      { kind: 'ollama', service: 'b_ollama', stack: 'b', port: 11434, baseUrl: 'http://b_ollama:11434' },
      { kind: 'vllm', service: 'gpu_vllm', stack: 'gpu', port: 8000, baseUrl: 'http://gpu_vllm:8000' },
    ]);
  });
  it('a configured provider keeps its own base URL', () => {
    const merged = withDiscovered([p('ollama', { baseUrl: 'http://localhost:11434' })], [{ kind: 'ollama', service: 's', stack: null, port: 11434, baseUrl: 'http://s:11434' }]);
    expect(merged[0]!.baseUrl).toBe('http://localhost:11434');
    expect(merged[0]!.discovered).toEqual({ service: 's', stack: null });
  });
});

describe('guardrails', () => {
  it('redacts PII and secrets from log text', () => {
    const t = redactPii('mail bob@acme.com or +44 20 7946 0958, card 4242 4242 4242 4242, key sk-ant-abcdefghijklmnopqrstu, ip 10.1.2.3, ssn 123-45-6789');
    expect(t).toBe('mail [EMAIL] or [PHONE], card [CARD], key [KEY], ip [IP], ssn [SSN]');
  });
  it('keeps non-Luhn digit runs and ordinary text', () => {
    expect(redactPii('order 1234 5678 9012 3456 shipped')).toBe('order 1234 5678 9012 3456 shipped');
    expect(redactPii('version 1.2.3 is fine')).toBe('version 1.2.3 is fine');
  });
  it('estimates prompt size across system, messages, tools and embeddings input', () => {
    expect(estimatePromptTokens({ messages: [{ role: 'user', content: 'x'.repeat(400) }] })).toBe(100);
    expect(estimatePromptTokens({ system: 'abcd', messages: [{ role: 'user', content: [{ type: 'text', text: 'abcd' }] }] })).toBe(2);
    expect(estimatePromptTokens({ input: ['abcd', 'abcd'] })).toBe(2);
  });
});
