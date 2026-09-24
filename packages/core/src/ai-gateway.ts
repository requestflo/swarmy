/**
 * AI gateway — the pure, browser-safe model layer shared by the controller's
 * control plane (@swarmy/trpc ai.service), the data plane
 * (apps/api/src/ai-gateway.ts) and the dashboard.
 *
 * One answer for each question the gateway asks on every request:
 *   - which providers exist and how they are reached (PROVIDERS),
 *   - what a model costs (MODEL_CATALOG + costMicros — always an ESTIMATE),
 *   - what `fast` / `smart` / `embed` mean for this org (routes + defaults),
 *   - which concrete targets a requested name resolves to (resolveModel),
 *   - whether a key/app may use it (modelAllowed),
 *   - the org-config document codec (parseConfigDoc) and the per-key policy
 *     codec (parseKeyPolicy),
 *   - the log guardrails (redactPii, prompt-size estimate).
 *
 * No IO, no node:crypto — the browser bundle imports this through views.
 */

// ── providers ────────────────────────────────────────────────────────────────

export const AI_PROVIDER_KINDS = [
  'anthropic',
  'openai',
  'azure',
  'gemini',
  'bedrock',
  'mistral',
  'groq',
  'openrouter',
  'ollama',
  'vllm',
  'custom',
] as const;
export type AiProviderKind = (typeof AI_PROVIDER_KINDS)[number];

/** How a provider speaks on the wire (the translation the gateway applies). */
export type AiWire = 'openai' | 'anthropic' | 'gemini' | 'bedrock';

export interface AiProviderInfo {
  kind: AiProviderKind;
  label: string;
  wire: AiWire;
  /** Default API root (no trailing slash); null = the operator must give one. */
  defaultBaseUrl: string | null;
  /** Whether a credential is required (in-cluster engines run without one). */
  needsKey: boolean;
  /** Runs inside the swarm (Ollama / vLLM templates), reached over the overlay. */
  inCluster: boolean;
  /** What the credential field holds, for the UI. */
  keyHint: string;
  /** Model-id prefixes that route here when the provider is configured. */
  prefixes: readonly string[];
}

export const AI_PROVIDERS: Record<AiProviderKind, AiProviderInfo> = {
  anthropic: {
    kind: 'anthropic',
    label: 'Anthropic',
    wire: 'anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    needsKey: true,
    inCluster: false,
    keyHint: 'sk-ant-…',
    prefixes: ['claude'],
  },
  openai: {
    kind: 'openai',
    label: 'OpenAI',
    wire: 'openai',
    defaultBaseUrl: 'https://api.openai.com',
    needsKey: true,
    inCluster: false,
    keyHint: 'sk-…',
    prefixes: ['gpt', 'chatgpt', 'o1', 'o3', 'o4', 'text-embedding', 'omni-moderation'],
  },
  azure: {
    kind: 'azure',
    label: 'Azure OpenAI',
    wire: 'openai',
    defaultBaseUrl: null,
    needsKey: true,
    inCluster: false,
    keyHint: 'Azure resource key (base URL: https://<resource>.openai.azure.com)',
    prefixes: [],
  },
  gemini: {
    kind: 'gemini',
    label: 'Google Gemini',
    wire: 'gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    needsKey: true,
    inCluster: false,
    keyHint: 'AIza…',
    prefixes: ['gemini', 'text-embedding-004', 'gemma'],
  },
  bedrock: {
    kind: 'bedrock',
    label: 'AWS Bedrock',
    wire: 'bedrock',
    defaultBaseUrl: null,
    needsKey: true,
    inCluster: false,
    keyHint: 'ACCESS_KEY_ID:SECRET_ACCESS_KEY (set the region too)',
    prefixes: ['anthropic.', 'us.', 'eu.', 'apac.', 'global.', 'amazon.', 'meta.', 'cohere.', 'mistral.'],
  },
  mistral: {
    kind: 'mistral',
    label: 'Mistral',
    wire: 'openai',
    defaultBaseUrl: 'https://api.mistral.ai',
    needsKey: true,
    inCluster: false,
    keyHint: 'Mistral API key',
    prefixes: ['mistral', 'codestral', 'pixtral', 'ministral', 'magistral', 'open-mistral'],
  },
  groq: {
    kind: 'groq',
    label: 'Groq',
    wire: 'openai',
    defaultBaseUrl: 'https://api.groq.com/openai',
    needsKey: true,
    inCluster: false,
    keyHint: 'gsk_…',
    prefixes: [],
  },
  openrouter: {
    kind: 'openrouter',
    label: 'OpenRouter',
    wire: 'openai',
    defaultBaseUrl: 'https://openrouter.ai/api',
    needsKey: true,
    inCluster: false,
    keyHint: 'sk-or-…',
    prefixes: [],
  },
  ollama: {
    kind: 'ollama',
    label: 'Ollama (in-cluster)',
    wire: 'openai',
    defaultBaseUrl: null,
    needsKey: false,
    inCluster: true,
    keyHint: 'none needed',
    prefixes: [],
  },
  vllm: {
    kind: 'vllm',
    label: 'vLLM (in-cluster)',
    wire: 'openai',
    defaultBaseUrl: null,
    needsKey: false,
    inCluster: true,
    keyHint: 'optional (vLLM --api-key)',
    prefixes: [],
  },
  custom: {
    kind: 'custom',
    label: 'OpenAI-compatible',
    wire: 'openai',
    defaultBaseUrl: null,
    needsKey: true,
    inCluster: false,
    keyHint: 'bearer token',
    prefixes: [],
  },
};

export function isAiProviderKind(v: unknown): v is AiProviderKind {
  return typeof v === 'string' && (AI_PROVIDER_KINDS as readonly string[]).includes(v);
}

// ── catalogue + prices ───────────────────────────────────────────────────────

export type AiModelKind = 'chat' | 'embed';

export interface AiCatalogModel {
  id: string;
  provider: AiProviderKind;
  kind: AiModelKind;
  /** $/MTok input (== micro-dollars per token). */
  inUsd: number;
  /** $/MTok output. */
  outUsd: number;
  /** Context window in tokens (display only). */
  context?: number;
  /** Tool/function calling. */
  tools?: boolean;
}

const m = (
  provider: AiProviderKind,
  id: string,
  inUsd: number,
  outUsd: number,
  extra: Partial<AiCatalogModel> = {},
): AiCatalogModel => ({ id, provider, kind: 'chat', inUsd, outUsd, tools: true, ...extra });
const e = (provider: AiProviderKind, id: string, inUsd: number): AiCatalogModel => ({
  id,
  provider,
  kind: 'embed',
  inUsd,
  outUsd: 0,
});

/**
 * The model catalogue: what the playground offers and the price table the
 * meter uses. Static on purpose — cost is an estimate, never an invoice.
 */
export const MODEL_CATALOG: readonly AiCatalogModel[] = [
  // Anthropic (first-party rates)
  m('anthropic', 'claude-fable-5-1', 10, 50, { context: 1_000_000 }),
  m('anthropic', 'claude-fable-5', 10, 50, { context: 1_000_000 }),
  m('anthropic', 'claude-opus-5-5', 4, 20, { context: 1_000_000 }),
  m('anthropic', 'claude-opus-5', 5, 25, { context: 1_000_000 }),
  m('anthropic', 'claude-opus-4-8', 5, 25, { context: 1_000_000 }),
  m('anthropic', 'claude-sonnet-5', 2, 10, { context: 1_000_000 }),
  m('anthropic', 'claude-sonnet-4-6', 3, 15, { context: 1_000_000 }),
  m('anthropic', 'claude-haiku-4-5', 1, 5, { context: 200_000 }),
  // OpenAI
  m('openai', 'gpt-5', 1.25, 10, { context: 400_000 }),
  m('openai', 'gpt-5-mini', 0.25, 2, { context: 400_000 }),
  m('openai', 'gpt-5-nano', 0.05, 0.4, { context: 400_000 }),
  m('openai', 'gpt-4.1', 2, 8, { context: 1_000_000 }),
  m('openai', 'gpt-4.1-mini', 0.4, 1.6, { context: 1_000_000 }),
  m('openai', 'gpt-4.1-nano', 0.1, 0.4, { context: 1_000_000 }),
  m('openai', 'gpt-4o', 2.5, 10, { context: 128_000 }),
  m('openai', 'gpt-4o-mini', 0.15, 0.6, { context: 128_000 }),
  m('openai', 'o4-mini', 1.1, 4.4, { context: 200_000 }),
  m('openai', 'o3', 2, 8, { context: 200_000 }),
  m('openai', 'o1', 15, 60, { context: 200_000 }),
  e('openai', 'text-embedding-3-small', 0.02),
  e('openai', 'text-embedding-3-large', 0.13),
  // Google Gemini
  m('gemini', 'gemini-2.5-pro', 1.25, 10, { context: 1_000_000 }),
  m('gemini', 'gemini-2.5-flash', 0.3, 2.5, { context: 1_000_000 }),
  m('gemini', 'gemini-2.5-flash-lite', 0.1, 0.4, { context: 1_000_000 }),
  e('gemini', 'gemini-embedding-001', 0.15),
  e('gemini', 'text-embedding-004', 0),
  // Mistral
  m('mistral', 'mistral-large-latest', 2, 6, { context: 128_000 }),
  m('mistral', 'mistral-medium-latest', 0.4, 2, { context: 128_000 }),
  m('mistral', 'mistral-small-latest', 0.1, 0.3, { context: 128_000 }),
  m('mistral', 'codestral-latest', 0.3, 0.9, { context: 256_000 }),
  e('mistral', 'mistral-embed', 0.1),
  // Groq
  m('groq', 'llama-3.3-70b-versatile', 0.59, 0.79, { context: 128_000 }),
  m('groq', 'llama-3.1-8b-instant', 0.05, 0.08, { context: 128_000 }),
  m('groq', 'openai/gpt-oss-120b', 0.15, 0.75, { context: 128_000 }),
  m('groq', 'openai/gpt-oss-20b', 0.1, 0.5, { context: 128_000 }),
  // AWS Bedrock (on-demand, us-east-1)
  m('bedrock', 'amazon.nova-pro-v1:0', 0.8, 3.2, { context: 300_000 }),
  m('bedrock', 'amazon.nova-lite-v1:0', 0.06, 0.24, { context: 300_000 }),
  m('bedrock', 'amazon.nova-micro-v1:0', 0.035, 0.14, { context: 128_000 }),
  m('bedrock', 'meta.llama3-3-70b-instruct-v1:0', 0.72, 0.72, { context: 128_000 }),
  e('bedrock', 'amazon.titan-embed-text-v2:0', 0.02),
  // OpenRouter (vendor/model ids — priced from the vendor's own rate when known)
  m('openrouter', 'openai/gpt-5-mini', 0.25, 2),
  m('openrouter', 'anthropic/claude-sonnet-4.5', 3, 15),
  m('openrouter', 'meta-llama/llama-3.3-70b-instruct', 0.13, 0.4),
  // In-cluster (self-hosted: no per-token bill)
  m('ollama', 'llama3.2:3b', 0, 0, { context: 128_000 }),
  m('ollama', 'qwen2.5:0.5b', 0, 0, { context: 32_000 }),
  e('ollama', 'nomic-embed-text', 0),
  e('ollama', 'all-minilm', 0),
];

/** Prefix fallbacks after the exact catalogue (unknown point releases). */
const PRICE_PREFIXES: ReadonlyArray<{ prefix: string; inUsd: number; outUsd: number }> = [
  { prefix: 'claude-fable', inUsd: 10, outUsd: 50 },
  { prefix: 'claude-opus', inUsd: 5, outUsd: 25 },
  { prefix: 'claude-sonnet', inUsd: 3, outUsd: 15 },
  { prefix: 'claude-haiku', inUsd: 1, outUsd: 5 },
  { prefix: 'claude', inUsd: 5, outUsd: 25 },
  { prefix: 'gpt-5', inUsd: 1.25, outUsd: 10 },
  { prefix: 'gpt-4o-mini', inUsd: 0.15, outUsd: 0.6 },
  { prefix: 'gpt-4o', inUsd: 2.5, outUsd: 10 },
  { prefix: 'text-embedding', inUsd: 0.1, outUsd: 0 },
  { prefix: 'gemini-2.5-flash', inUsd: 0.3, outUsd: 2.5 },
  { prefix: 'gemini', inUsd: 1.25, outUsd: 10 },
  { prefix: 'mistral-large', inUsd: 2, outUsd: 6 },
  { prefix: 'mistral', inUsd: 0.4, outUsd: 2 },
  { prefix: 'amazon.nova', inUsd: 0.8, outUsd: 3.2 },
  { prefix: 'amazon.titan-embed', inUsd: 0.02, outUsd: 0 },
];

/** Unknown models bill at a modest middle rate — still marked estimate. */
export const DEFAULT_PRICE = { inUsd: 2, outUsd: 8 } as const;

/**
 * Normalise a provider-specific id to the vendor model for pricing:
 * `us.anthropic.claude-sonnet-4-6-v1:0` → `claude-sonnet-4-6-v1:0`,
 * `anthropic/claude-sonnet-4.5` stays (OpenRouter rows are exact).
 */
function priceKey(model: string): string[] {
  const mdl = model.toLowerCase();
  const out = [mdl];
  const bedrock = mdl.replace(/^(us|eu|apac|global)\./, '');
  if (bedrock !== mdl) out.push(bedrock);
  const anth = bedrock.replace(/^anthropic\./, '');
  if (anth !== bedrock) out.push(anth);
  const slash = mdl.indexOf('/');
  if (slash > 0) out.push(mdl.slice(slash + 1).replace(/\./g, '-'));
  return out;
}

/** $/MTok for a model (exact catalogue row → prefix table → default). */
export function modelPrice(model: string, provider?: AiProviderKind | null): { inUsd: number; outUsd: number } {
  if (provider && AI_PROVIDERS[provider]?.inCluster) return { inUsd: 0, outUsd: 0 };
  for (const k of priceKey(model)) {
    const row = MODEL_CATALOG.find((r) => r.id.toLowerCase() === k && (!provider || r.provider === provider))
      ?? MODEL_CATALOG.find((r) => r.id.toLowerCase() === k);
    if (row) return { inUsd: row.inUsd, outUsd: row.outUsd };
  }
  for (const k of priceKey(model)) {
    const hit = [...PRICE_PREFIXES].sort((a, b) => b.prefix.length - a.prefix.length).find((r) => k.startsWith(r.prefix));
    if (hit) return { inUsd: hit.inUsd, outUsd: hit.outUsd };
  }
  return DEFAULT_PRICE;
}

/** Estimated cost in micro-dollars (1e-6 USD). Rates are $/MTok = µ$/token. */
export function costMicros(
  model: string,
  inTokens: number,
  outTokens: number,
  provider?: AiProviderKind | null,
): number {
  const rate = modelPrice(model, provider);
  return Math.round(inTokens * rate.inUsd + outTokens * rate.outUsd);
}

// ── org config document (AiProviderConfig.providersJson) ─────────────────────

export interface AiProviderDescriptor {
  kind: AiProviderKind;
  baseUrl: string | null;
  isDefault: boolean;
  /** Bedrock region (e.g. us-east-1). */
  region?: string;
  /** Azure OpenAI api-version. */
  apiVersion?: string;
  /** Azure: model id → deployment name (default: the model id itself). */
  deployments?: Record<string, string>;
  /** Auto-registered from a live in-cluster service (never persisted). */
  discovered?: { service: string; stack: string | null };
}

export interface AiRouteTarget {
  provider: AiProviderKind;
  model: string;
  /** Load-balancing weight (balance strategy). Default 1. */
  weight?: number;
}

export type AiRouteStrategy = 'fallback' | 'balance';

/** A named route (alias): ordered targets + how to pick among them. */
export interface AiRoute {
  strategy: AiRouteStrategy;
  targets: AiRouteTarget[];
}

export interface AiGuardrailSettings {
  /** Scrub emails, phones, cards, keys, IPs from the request log (default on). */
  redactPii: boolean;
  /** Refuse prompts above this estimated token count (null = no cap). */
  maxPromptTokens: number | null;
}

export interface AiGatewaySettings {
  auditLog: boolean;
  cache: boolean;
  guardrails: AiGuardrailSettings;
}

export interface AiConfigDoc {
  providers: AiProviderDescriptor[];
  settings: AiGatewaySettings;
  /** Stack → public outlet domain; the edge renders one gateway vhost per entry. */
  outlets: Record<string, string>;
  /** Org routes/aliases (`fast`, `smart`, `embed`, or any name). */
  routes: Record<string, AiRoute>;
  /** Per-app (stack) model allowlists, on top of each key's own. */
  apps: Record<string, { models: string[] }>;
}

export const DEFAULT_GUARDRAILS: AiGuardrailSettings = { redactPii: true, maxPromptTokens: null };
const defaultSettings = (): AiGatewaySettings => ({
  auditLog: false,
  cache: false,
  guardrails: { ...DEFAULT_GUARDRAILS },
});

const ROUTE_NAME_RE = /^[a-z0-9][a-z0-9._:-]{0,62}$/i;

function trimUrl(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().replace(/\/+$/, '') : null;
}

function parseTargets(raw: unknown): AiRouteTarget[] {
  if (!Array.isArray(raw)) return [];
  const out: AiRouteTarget[] = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const o = t as { provider?: unknown; model?: unknown; weight?: unknown };
    if (!isAiProviderKind(o.provider) || typeof o.model !== 'string' || !o.model.trim()) continue;
    const weight = typeof o.weight === 'number' && Number.isFinite(o.weight) && o.weight > 0 ? o.weight : undefined;
    out.push({ provider: o.provider, model: o.model.trim(), ...(weight !== undefined ? { weight } : {}) });
  }
  return out;
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim()) : [];
}

/**
 * Parse the `providersJson` column. Tolerant of the spine default (`[]`), a
 * bare descriptor array, or the wrapper document — malformed entries are
 * dropped, never thrown on. The ONE codec: the gateway and the control plane
 * both call it.
 */
export function parseConfigDoc(raw: unknown): AiConfigDoc {
  const doc: AiConfigDoc = { providers: [], settings: defaultSettings(), outlets: {}, routes: {}, apps: {} };
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const list = Array.isArray(raw) ? raw : Array.isArray(obj?.providers) ? (obj!.providers as unknown[]) : [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const en = entry as Record<string, unknown>;
    if (!isAiProviderKind(en.kind)) continue;
    if (doc.providers.some((p) => p.kind === en.kind)) continue;
    const d: AiProviderDescriptor = { kind: en.kind, baseUrl: trimUrl(en.baseUrl), isDefault: en.isDefault === true };
    if (typeof en.region === 'string' && /^[a-z]{2}(-[a-z]+)+-\d$/.test(en.region.trim())) d.region = en.region.trim();
    if (typeof en.apiVersion === 'string' && en.apiVersion.trim()) d.apiVersion = en.apiVersion.trim();
    if (en.deployments && typeof en.deployments === 'object' && !Array.isArray(en.deployments)) {
      const deps: Record<string, string> = {};
      for (const [k, v] of Object.entries(en.deployments as Record<string, unknown>)) {
        if (typeof v === 'string' && v.trim()) deps[k] = v.trim();
      }
      if (Object.keys(deps).length) d.deployments = deps;
    }
    doc.providers.push(d);
  }
  const s = obj?.settings;
  if (s && typeof s === 'object') {
    const st = s as Record<string, unknown>;
    const g = (st.guardrails && typeof st.guardrails === 'object' ? st.guardrails : {}) as Record<string, unknown>;
    const cap = g.maxPromptTokens;
    doc.settings = {
      auditLog: st.auditLog === true,
      cache: st.cache === true,
      guardrails: {
        redactPii: g.redactPii !== false,
        maxPromptTokens: typeof cap === 'number' && Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : null,
      },
    };
  }
  const outlets = obj?.outlets;
  if (outlets && typeof outlets === 'object' && !Array.isArray(outlets)) {
    for (const [stack, domain] of Object.entries(outlets as Record<string, unknown>)) {
      if (typeof domain === 'string' && domain.trim()) doc.outlets[stack] = domain.trim().toLowerCase();
    }
  }
  const routes = obj?.routes;
  if (routes && typeof routes === 'object' && !Array.isArray(routes)) {
    for (const [name, r] of Object.entries(routes as Record<string, unknown>)) {
      if (!ROUTE_NAME_RE.test(name) || !r || typeof r !== 'object') continue;
      const rr = r as { strategy?: unknown; targets?: unknown };
      const targets = parseTargets(rr.targets);
      if (!targets.length) continue;
      doc.routes[name] = { strategy: rr.strategy === 'balance' ? 'balance' : 'fallback', targets };
    }
  }
  const apps = obj?.apps;
  if (apps && typeof apps === 'object' && !Array.isArray(apps)) {
    for (const [stack, a] of Object.entries(apps as Record<string, unknown>)) {
      const models = strList((a as { models?: unknown } | null)?.models);
      if (models.length) doc.apps[stack] = { models };
    }
  }
  // At most one default; the first wins.
  let seenDefault = false;
  for (const p of doc.providers) {
    if (p.isDefault && seenDefault) p.isDefault = false;
    if (p.isDefault) seenDefault = true;
  }
  return doc;
}

/** Serialise the doc back to the column shape (drops discovered providers). */
export function serializeConfigDoc(doc: AiConfigDoc): Record<string, unknown> {
  return {
    providers: doc.providers.filter((p) => !p.discovered).map(({ discovered: _d, ...rest }) => rest),
    settings: doc.settings,
    outlets: doc.outlets,
    routes: doc.routes,
    apps: doc.apps,
  };
}

// ── per-key policy (AiVirtualKey.limitsJson) ─────────────────────────────────

export interface AiKeyPolicy {
  rpm: number | null;
  dailyBudgetMicros: number | null;
  /** `key` = this key's own spend; `app` = every key minted for the same app (stack). */
  budgetScope: 'key' | 'app';
  /** Model allowlist (alias names, model ids, `provider/*`, `*`). null = any. */
  models: string[] | null;
  /** Prompt-size cap for this key (estimated tokens). */
  maxPromptTokens: number | null;
  /** User id of the member who minted the key — the ABAC principal for `ai.use`. */
  mintedBy: string | null;
}

const posNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

export function parseKeyPolicy(raw: unknown): AiKeyPolicy {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const rpm = posNum(o.rpm);
  const cap = posNum(o.maxPromptTokens);
  const models = Array.isArray(o.models) ? strList(o.models) : null;
  return {
    rpm: rpm !== null ? Math.floor(rpm) : null,
    dailyBudgetMicros: posNum(o.dailyBudgetMicros),
    budgetScope: o.budgetScope === 'app' ? 'app' : 'key',
    models: models && models.length ? models : null,
    maxPromptTokens: cap !== null ? Math.floor(cap) : null,
    mintedBy: typeof o.mintedBy === 'string' && o.mintedBy ? o.mintedBy : null,
  };
}

// ── routing ──────────────────────────────────────────────────────────────────

/** The aliases every org gets without configuring anything. */
export const DEFAULT_ALIASES = ['fast', 'smart', 'embed'] as const;

/** Default alias → preferred target per provider (first configured ones win, the rest are fallbacks). */
const DEFAULT_ALIAS_TARGETS: Record<(typeof DEFAULT_ALIASES)[number], AiRouteTarget[]> = {
  fast: [
    { provider: 'anthropic', model: 'claude-haiku-4-5' },
    { provider: 'openai', model: 'gpt-5-mini' },
    { provider: 'gemini', model: 'gemini-2.5-flash' },
    { provider: 'groq', model: 'llama-3.1-8b-instant' },
    { provider: 'mistral', model: 'mistral-small-latest' },
    { provider: 'azure', model: 'gpt-4o-mini' },
    { provider: 'bedrock', model: 'amazon.nova-lite-v1:0' },
    { provider: 'openrouter', model: 'openai/gpt-5-mini' },
    { provider: 'ollama', model: 'llama3.2:3b' },
  ],
  smart: [
    { provider: 'anthropic', model: 'claude-sonnet-5' },
    { provider: 'openai', model: 'gpt-5' },
    { provider: 'gemini', model: 'gemini-2.5-pro' },
    { provider: 'mistral', model: 'mistral-large-latest' },
    { provider: 'azure', model: 'gpt-4.1' },
    { provider: 'bedrock', model: 'amazon.nova-pro-v1:0' },
    { provider: 'groq', model: 'llama-3.3-70b-versatile' },
    { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5' },
  ],
  embed: [
    { provider: 'openai', model: 'text-embedding-3-small' },
    { provider: 'gemini', model: 'gemini-embedding-001' },
    { provider: 'mistral', model: 'mistral-embed' },
    { provider: 'azure', model: 'text-embedding-3-small' },
    { provider: 'bedrock', model: 'amazon.titan-embed-text-v2:0' },
    { provider: 'ollama', model: 'nomic-embed-text' },
  ],
};

/** The effective routes: org routes over the defaults (defaults filtered to configured providers). */
export function effectiveRoutes(doc: Pick<AiConfigDoc, 'routes'>, configured: readonly AiProviderKind[]): Record<string, AiRoute> {
  const have = new Set(configured);
  const out: Record<string, AiRoute> = {};
  for (const alias of DEFAULT_ALIASES) {
    const targets = DEFAULT_ALIAS_TARGETS[alias].filter((t) => have.has(t.provider));
    if (targets.length) out[alias] = { strategy: 'fallback', targets };
  }
  for (const [name, r] of Object.entries(doc.routes)) out[name] = r;
  return out;
}

export interface ResolvedModel {
  /** What the caller asked for. */
  requested: string;
  /** Set when the name is a route/alias. */
  alias: string | null;
  strategy: AiRouteStrategy;
  targets: AiRouteTarget[];
}

/** Model-id → provider by prefix / catalogue (only among configured providers). */
export function providerForModel(model: string, configured: readonly AiProviderKind[]): AiProviderKind | null {
  const mdl = model.toLowerCase();
  const have = new Set(configured);
  const cat = MODEL_CATALOG.find((r) => r.id.toLowerCase() === mdl && have.has(r.provider));
  if (cat) return cat.provider;
  for (const kind of configured) {
    const info = AI_PROVIDERS[kind];
    if (info.prefixes.some((p) => (p.endsWith('.') || p.length > 2 ? mdl.startsWith(p) : new RegExp(`^${p}(\\b|-|$)`).test(mdl)))) {
      // `o1`/`o3`/`o4` must be the o-series, not e.g. "ollama-…" (handled by the regex branch).
      return kind;
    }
  }
  // Claude/GPT ids reach the cloud platforms that host them.
  if (mdl.startsWith('claude') && have.has('bedrock')) return null;
  if (/^(gpt|o\d|text-embedding)/.test(mdl) && have.has('azure')) return 'azure';
  return null;
}

/**
 * Resolve a requested name to ordered targets:
 *   1. a route/alias (`smart`, or an org route) → its targets;
 *   2. `provider/model` with a configured provider (`groq/llama-3.1-8b-instant`,
 *      `openrouter/anthropic/claude-sonnet-4.5`, `ollama/llama3.2:3b`);
 *   3. a model id routed by catalogue/prefix;
 *   4. the org's default provider (else the first configured).
 * Returns null when nothing configured can take it.
 */
export function resolveModel(
  requested: string,
  doc: Pick<AiConfigDoc, 'routes' | 'providers'>,
): ResolvedModel | null {
  const name = requested.trim();
  if (!name) return null;
  const configured = doc.providers.map((p) => p.kind);
  const routes = effectiveRoutes(doc, configured);
  const route = routes[name];
  if (route) {
    const targets = route.targets.filter((t) => configured.includes(t.provider));
    if (!targets.length) return null;
    return { requested: name, alias: name, strategy: route.strategy, targets };
  }
  // A default alias with no configured provider behind it is not a model id.
  if ((DEFAULT_ALIASES as readonly string[]).includes(name)) return null;
  const slash = name.indexOf('/');
  if (slash > 0) {
    const head = name.slice(0, slash);
    if (isAiProviderKind(head) && configured.includes(head)) {
      return { requested: name, alias: null, strategy: 'fallback', targets: [{ provider: head, model: name.slice(slash + 1) }] };
    }
  }
  const byPrefix = providerForModel(name, configured);
  if (byPrefix) return { requested: name, alias: null, strategy: 'fallback', targets: [{ provider: byPrefix, model: name }] };
  const def = doc.providers.find((p) => p.isDefault) ?? doc.providers[0];
  if (!def) return null;
  return { requested: name, alias: null, strategy: 'fallback', targets: [{ provider: def.kind, model: name }] };
}

/**
 * Order targets for one request: `fallback` keeps the declared order;
 * `balance` draws a weighted-random first choice and keeps the rest (in
 * declared order) as fallbacks. `rand` is injectable for tests.
 */
export function orderTargets(r: Pick<ResolvedModel, 'strategy' | 'targets'>, rand: () => number = Math.random): AiRouteTarget[] {
  if (r.strategy !== 'balance' || r.targets.length < 2) return [...r.targets];
  const total = r.targets.reduce((s, t) => s + (t.weight ?? 1), 0);
  let x = rand() * total;
  let idx = 0;
  for (let i = 0; i < r.targets.length; i++) {
    x -= r.targets[i]!.weight ?? 1;
    if (x < 0) {
      idx = i;
      break;
    }
  }
  const first = r.targets[idx]!;
  return [first, ...r.targets.filter((_, i) => i !== idx)];
}

// ── allowlists ───────────────────────────────────────────────────────────────

function patternMatches(pattern: string, requested: string, targets: readonly AiRouteTarget[]): boolean {
  const p = pattern.trim().toLowerCase();
  const req = requested.toLowerCase();
  if (p === '*' || p === req) return true;
  if (p.endsWith('/*')) {
    const prov = p.slice(0, -2);
    return targets.length > 0 && targets.every((t) => t.provider === prov);
  }
  // A concrete model is allowed when the pattern names exactly that target.
  return targets.length === 1 && (p === targets[0]!.model.toLowerCase() || p === `${targets[0]!.provider}/${targets[0]!.model}`.toLowerCase());
}

/**
 * May a caller use this model? Every non-null allowlist (key, app) must
 * contain a matching entry — alias name, model id, `provider/model`,
 * `provider/*` or `*`. A null list is "no restriction at that level".
 */
export function modelAllowed(
  resolved: Pick<ResolvedModel, 'requested' | 'targets'>,
  lists: ReadonlyArray<readonly string[] | null | undefined>,
): boolean {
  for (const list of lists) {
    if (!list) continue;
    if (!list.some((pat) => patternMatches(pat, resolved.requested, resolved.targets))) return false;
  }
  return true;
}

/** ABAC resource for `ai.use` — the model (alias or id) with its provider(s) as labels. */
export function aiModelResource(orgId: string, resolved: Pick<ResolvedModel, 'requested' | 'alias' | 'targets'>): {
  type: 'aiModel';
  id: string;
  orgId: string;
  labels: Record<string, string>;
} {
  const providers = [...new Set(resolved.targets.map((t) => t.provider))].sort();
  return {
    type: 'aiModel',
    id: resolved.requested,
    orgId,
    labels: {
      'swarmy.ai.provider': providers.join(','),
      ...(resolved.alias ? { 'swarmy.ai.alias': resolved.alias } : {}),
      'swarmy.ai.cost': providers.every((p) => AI_PROVIDERS[p].inCluster) ? 'free' : 'paid',
    },
  };
}

// ── in-cluster discovery ─────────────────────────────────────────────────────

/** Service label an operator may set to register any OpenAI-compatible engine. */
export const AI_PROVIDER_LABEL = 'swarmy.ai.provider';
export const AI_PORT_LABEL = 'swarmy.ai.port';

const IN_CLUSTER_IMAGES: ReadonlyArray<{ kind: 'ollama' | 'vllm'; re: RegExp; port: number }> = [
  { kind: 'ollama', re: /(^|\/)ollama\/ollama(:|@|$)/, port: 11434 },
  { kind: 'vllm', re: /(^|\/)vllm\/vllm-openai(:|@|$)|vllm-cpu|(^|\/)vllm(:|@|$)/, port: 8000 },
];

export interface InClusterModelService {
  kind: 'ollama' | 'vllm';
  service: string;
  stack: string | null;
  port: number;
  baseUrl: string;
}

/**
 * Live services that are in-cluster model servers — the Ollama / vLLM
 * templates (matched by image) or anything labelled `swarmy.ai.provider`.
 * The first per kind wins (sorted by name for determinism).
 */
export function discoverInClusterModels(
  services: ReadonlyArray<{ name: string; image: string; stack?: string | null; labels?: Record<string, string> }>,
): InClusterModelService[] {
  const out: InClusterModelService[] = [];
  for (const s of [...services].sort((a, b) => a.name.localeCompare(b.name))) {
    const label = s.labels?.[AI_PROVIDER_LABEL];
    const img = s.image.toLowerCase();
    const hit =
      label === 'ollama' || label === 'vllm'
        ? IN_CLUSTER_IMAGES.find((i) => i.kind === label)
        : IN_CLUSTER_IMAGES.find((i) => i.re.test(img.split('@')[0] ?? img));
    if (!hit || out.some((o) => o.kind === hit.kind)) continue;
    const portLabel = Number(s.labels?.[AI_PORT_LABEL]);
    const port = Number.isInteger(portLabel) && portLabel > 0 ? portLabel : hit.port;
    out.push({ kind: hit.kind, service: s.name, stack: s.stack ?? null, port, baseUrl: `http://${s.name}:${port}` });
  }
  return out;
}

/** Merge discovered in-cluster engines into the configured providers (configured wins). */
export function withDiscovered(
  providers: readonly AiProviderDescriptor[],
  found: readonly InClusterModelService[],
): AiProviderDescriptor[] {
  const out = providers.map((p) => ({ ...p }));
  for (const f of found) {
    const existing = out.find((p) => p.kind === f.kind);
    if (existing) {
      if (!existing.baseUrl) existing.baseUrl = f.baseUrl;
      existing.discovered ??= { service: f.service, stack: f.stack };
      continue;
    }
    out.push({ kind: f.kind, baseUrl: f.baseUrl, isDefault: false, discovered: { service: f.service, stack: f.stack } });
  }
  return out;
}

// ── guardrails ───────────────────────────────────────────────────────────────

const PII_RULES: ReadonlyArray<{ tag: string; re: RegExp; check?: (s: string) => boolean }> = [
  // Secrets first so a key is never half-eaten by the phone rule.
  { tag: 'KEY', re: /\b(?:sk-(?:ant-|or-|proj-)?[A-Za-z0-9_-]{16,}|swk-ai-[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|(?:AKIA|ASIA)[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,})\b/g },
  { tag: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { tag: 'EMAIL', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { tag: 'CARD', re: /\b(?:\d[ -]?){12,18}\d\b/g, check: (s) => luhn(s.replace(/\D/g, '')) },
  { tag: 'IBAN', re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/g },
  { tag: 'SSN', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { tag: 'PHONE', re: /(?<![\w+])\+?\d{1,3}[ .-]?(?:\(\d{1,4}\)[ .-]?)?\d{2,4}[ .-]\d{3,4}[ .-]?\d{2,4}\b/g, check: phoneLike },
  { tag: 'IP', re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
];

/** A phone, not a digit run: 9–15 digits, and not uniform 4-digit groups (card/order numbers). */
function phoneLike(hit: string): boolean {
  const digits = hit.replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 15) return false;
  if (hit.startsWith('+') || hit.includes('(')) return true;
  const groups = hit.split(/[ .-]+/).filter(Boolean);
  return !groups.every((g) => g.length === 4);
}

function luhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** Replace PII / secrets with `[EMAIL]`, `[CARD]`, … (log guardrail). */
export function redactPii(text: string): string {
  let out = text;
  for (const rule of PII_RULES) {
    out = out.replace(rule.re, (hit) => (rule.check && !rule.check(hit) ? hit : `[${rule.tag}]`));
  }
  return out;
}

/** Every text fragment of a chat / messages / embeddings body (for size caps + logs). */
export function promptTexts(body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  const b = body as Record<string, unknown>;
  const out: string[] = [];
  const push = (c: unknown): void => {
    if (typeof c === 'string') out.push(c);
    else if (Array.isArray(c)) {
      for (const part of c) {
        if (typeof part === 'string') out.push(part);
        else if (part && typeof part === 'object') {
          const p = part as Record<string, unknown>;
          if (typeof p.text === 'string') out.push(p.text);
          if (p.content !== undefined) push(p.content);
          if (p.input !== undefined && typeof p.input === 'object') out.push(JSON.stringify(p.input));
        }
      }
    }
  };
  push(b.system);
  if (Array.isArray(b.messages)) for (const msg of b.messages) push((msg as { content?: unknown } | null)?.content);
  push(b.input);
  push(b.prompt);
  if (Array.isArray(b.tools)) out.push(JSON.stringify(b.tools));
  return out;
}

/** ~4 chars/token estimate of the whole prompt (the prompt-size cap's unit). */
export function estimatePromptTokens(body: unknown): number {
  return Math.ceil(promptTexts(body).reduce((n, t) => n + t.length, 0) / 4);
}

// ── in-process runner seam (playground) ──────────────────────────────────────

/** One gateway call made from inside the controller (the dashboard playground). */
export interface AiGatewayRunInput {
  orgId: string;
  keyId: string;
  /** The member running it — also checked for `ai.use` on the model. */
  userId: string;
  path: '/v1/chat/completions' | '/v1/embeddings';
  body: Record<string, unknown>;
}

export interface AiGatewayRunOutput {
  status: number;
  json: unknown;
  provider: string | null;
  model: string | null;
  inTokens: number;
  outTokens: number;
  costMicros: number;
  latencyMs: number;
  attempts: Array<{ provider: string; model: string; status: number | null; error: string | null }>;
  traceId: string | null;
}

export type AiGatewayRunner = (input: AiGatewayRunInput) => Promise<AiGatewayRunOutput>;

let runner: AiGatewayRunner | null = null;

/**
 * The data plane (apps/api) registers its engine here at boot so the control
 * plane (@swarmy/trpc) can run a playground request through the SAME path —
 * key limits, allowlists, ABAC, guardrails, fallbacks, metering, traces —
 * without an HTTP loopback or a bearer token in the browser.
 */
export function registerAiGatewayRunner(fn: AiGatewayRunner | null): void {
  runner = fn;
}

export function aiGatewayRunner(): AiGatewayRunner | null {
  return runner;
}

/** "Test" button: one cheap upstream call to a provider with the stored credential. */
export type AiProviderProbe = (orgId: string, provider: AiProviderKind) => Promise<{
  ok: boolean;
  latencyMs: number;
  target: string;
  message: string | null;
}>;

let probe: AiProviderProbe | null = null;

export function registerAiProviderProbe(fn: AiProviderProbe | null): void {
  probe = fn;
}

export function aiProviderProbe(): AiProviderProbe | null {
  return probe;
}

/** The cheapest catalogue chat model per provider (the Test button's 1-token ping). */
export function probeModel(provider: AiProviderKind): string | null {
  const rows = MODEL_CATALOG.filter((r) => r.provider === provider && r.kind === 'chat');
  if (!rows.length) return null;
  return [...rows].sort((a, b) => a.inUsd + a.outUsd - (b.inUsd + b.outUsd))[0]!.id;
}
