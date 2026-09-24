import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import {
  AI_PROVIDERS,
  checkProviderUrl,
  type HostResolver,
  MODEL_CATALOG,
  aiGatewayRunner,
  aiModelResource,
  aiProviderProbe,
  buildInventory,
  discoverInClusterModels,
  effectiveRoutes,
  modelPrice,
  parseConfigDoc,
  parseKeyPolicy,
  resolveModel,
  serializeConfigDoc,
  withDiscovered,
  STACK_LABEL,
  type AiAttachResult,
  type AiConfigDoc,
  type AiKeyLimitsView,
  type AiKeyMintResult,
  type AiKeyView,
  type AiModelOptionView,
  type AiModelsView,
  type AiPlaygroundResult,
  type AiProviderDescriptor,
  type AiProviderKind,
  type AiProviderView,
  type AiProvidersView,
  type AiRequestLogView,
  type AiSettingsView,
  type AiTestResult,
  type AiUsageBreakdownRow,
  type AiUsageDayView,
  type AiUsageSummaryView,
  type InvService,
} from '@swarmy/core';
import { decryptSecret, encryptSecret, hashToken } from '@swarmy/core/crypto';
import type {
  AiLogsInput,
  AiPlaygroundInput,
  AiSettingsInput,
  AiUsageInput,
  AttachAiInput,
  MintAiKeyInput,
  SetAiAppModelsInput,
  SetAiProviderInput,
  SetAiRouteInput,
  UpdateAiKeyInput,
} from '@swarmy/core';
import type { OrgContext } from '../context';
import { commandRejected, mapDispatchError, notFound, policyDenied } from '../errors';
import { evaluateAccess } from '../abac';
import { writeAudit } from './audit.service';
import { resolveManagerNode } from './dispatch.service';
import { patchLiveService } from './service-patch';
import {
  listAppSecretVersions,
  materializeSecretVars,
  mountedVersions,
  planSecretSpec,
  versionsOf,
} from './app-secrets.service';

/**
 * AI gateway control plane — providers, routes/aliases, model allowlists,
 * virtual keys, usage/cost queries, request log, settings, the playground and
 * the app wiring (attach + the swarmy.yaml `ai:` binding).
 *
 * Storage split:
 *   - `AiProviderConfig.providersJson` — the org config document
 *     (@swarmy/core `parseConfigDoc`): provider descriptors, settings
 *     (audit/cache/guardrails), outlets, routes, per-app allowlists. NO secrets.
 *   - `AiProviderConfig.configEnc` — vault-encrypted JSON map kind→credential.
 *     Write-only: decrypted only by the gateway data plane at call time.
 *   - `AiVirtualKey.keyHash` — sha-256 of `swk-ai-…`; `limitsJson` is the key
 *     policy (@swarmy/core `parseKeyPolicy`: rpm, budget, models, prompt cap,
 *     mintedBy). The plaintext is returned exactly once from {@link mintKey}.
 *   - `AiUsage` / `AiRequestLog` — written by the gateway; read here.
 *   - In-cluster engines (Ollama / vLLM) are NOT stored: they are discovered
 *     from the live inventory on every read (Docker is the truth).
 */

export { parseConfigDoc };
export type { AiConfigDoc, AiProviderDescriptor };

export const GATEWAY_PATH = '/ai/v1';
const CONTROLLER_PUBLIC_URL =
  process.env.CONTROLLER_PUBLIC_URL ?? process.env.BETTER_AUTH_URL ?? 'http://localhost:3021';

export function gatewayUrl(): string {
  return `${CONTROLLER_PUBLIC_URL.replace(/\/+$/, '')}${GATEWAY_PATH}`;
}

/** Anthropic SDKs append `/v1/messages` themselves: their base is `<controller>/ai`. */
export function anthropicGatewayUrl(): string {
  return gatewayUrl().replace(/\/v1$/, '');
}

/** On an APP service: gateway wiring markers (mirrors swarmy.cache.inject). */
export const AI_INJECT_LABEL = 'swarmy.ai.inject';
export const AI_INJECT_KEY_LABEL = 'swarmy.ai.inject.key';
const MANAGED_LABEL = 'swarmy.managed';

export const AI_ENV_VAR = 'AI_GATEWAY_URL';
export const AI_KEY_FILE_VAR = 'AI_GATEWAY_KEY_FILE';

const USD_PER_MICRO = 1 / 1_000_000;

/** Parse `AiVirtualKey.limitsJson` → the limits view (invalid values → null). */
export function parseKeyLimits(raw: unknown): AiKeyLimitsView {
  const p = parseKeyPolicy(raw);
  return {
    rpm: p.rpm,
    dailyBudgetUsd: p.dailyBudgetMicros !== null ? p.dailyBudgetMicros * USD_PER_MICRO : null,
    ...(p.budgetScope === 'app' ? { budgetScope: 'app' as const } : {}),
    ...(p.models ? { models: p.models } : {}),
    ...(p.maxPromptTokens !== null ? { maxPromptTokens: p.maxPromptTokens } : {}),
  };
}

/** Decrypt the provider credential map from `configEnc` ({} when unset/undecryptable). */
function decryptKeyMap(configEnc: string | null): Partial<Record<AiProviderKind, string>> {
  if (!configEnc) return {};
  try {
    const parsed = JSON.parse(decryptSecret(configEnc)) as Record<string, unknown>;
    const out: Partial<Record<AiProviderKind, string>> = {};
    for (const kind of Object.keys(AI_PROVIDERS) as AiProviderKind[]) {
      if (typeof parsed[kind] === 'string' && parsed[kind]) out[kind] = parsed[kind] as string;
    }
    return out;
  } catch {
    return {};
  }
}

// ── Config row access ─────────────────────────────────────────────────────────

interface ConfigRow {
  providersJson: unknown;
  configEnc: string | null;
}

async function loadConfig(ctx: OrgContext): Promise<ConfigRow> {
  const row = await ctx.db.aiProviderConfig.findUnique({ where: { orgId: ctx.activeOrgId } });
  return row ?? { providersJson: [], configEnc: null };
}

async function saveConfig(ctx: OrgContext, doc: AiConfigDoc, configEnc: string | null): Promise<void> {
  const providersJson = serializeConfigDoc(doc) as object;
  await ctx.db.aiProviderConfig.upsert({
    where: { orgId: ctx.activeOrgId },
    create: { orgId: ctx.activeOrgId, providersJson, configEnc },
    update: { providersJson, configEnc },
  });
}

function liveOrgServices(ctx: OrgContext): InvService[] {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  return buildInventory(services, containers).services;
}

/** Configured providers + in-cluster engines discovered from the live inventory. */
function withLiveEngines(ctx: OrgContext, doc: AiConfigDoc): AiConfigDoc {
  let found: ReturnType<typeof discoverInClusterModels> = [];
  try {
    found = discoverInClusterModels(liveOrgServices(ctx).map((s) => ({ name: s.name, image: s.image, stack: s.stack, labels: s.labels })));
  } catch {
    found = [];
  }
  return { ...doc, providers: withDiscovered(doc.providers, found) };
}

// ── Providers ─────────────────────────────────────────────────────────────────

export async function getProviders(ctx: OrgContext): Promise<AiProvidersView> {
  const row = await loadConfig(ctx);
  const doc = withLiveEngines(ctx, parseConfigDoc(row.providersJson));
  const keys = decryptKeyMap(row.configEnc);
  const providers: AiProviderView[] = doc.providers.map((p) => ({
    kind: p.kind,
    baseUrl: p.baseUrl,
    hasKey: Boolean(keys[p.kind]) || !AI_PROVIDERS[p.kind].needsKey,
    isDefault: p.isDefault,
    region: p.region ?? null,
    apiVersion: p.apiVersion ?? null,
    discovered: p.discovered ?? null,
    inCluster: AI_PROVIDERS[p.kind].inCluster,
  }));
  return { providers, gatewayUrl: gatewayUrl() };
}

/** Resolve a hostname to every address (the SSRF guard checks all of them). */
const defaultHostResolver: HostResolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address);
let hostResolver: HostResolver = defaultHostResolver;

/** Test seam: swap the DNS resolver the provider URL check uses (null restores). */
export function setAiHostResolver(fn: HostResolver | null): void {
  hostResolver = fn ?? defaultHostResolver;
}

/** Hostnames of the org's in-cluster engines (Ollama / vLLM) — the SSRF allowlist. */
export function inClusterHosts(ctx: OrgContext): string[] {
  try {
    return discoverInClusterModels(
      liveOrgServices(ctx).map((s) => ({ name: s.name, image: s.image, stack: s.stack, labels: s.labels })),
    ).map((f) => new URL(f.baseUrl).hostname);
  } catch {
    return [];
  }
}

function originOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Whether a stored provider credential may stay when the base URL changes
 * without a new key. The stored key is only ever sent to the origin it was
 * entered for: a new origin drops it, so re-pointing a provider at another
 * host can never exfiltrate the org's key.
 */
export function keepsStoredKey(kind: AiProviderKind, prevBaseUrl: string | null, nextBaseUrl: string | null): boolean {
  const dflt = AI_PROVIDERS[kind].defaultBaseUrl;
  return originOf(prevBaseUrl ?? dflt) === originOf(nextBaseUrl ?? dflt);
}

export async function setProvider(ctx: OrgContext, input: SetAiProviderInput): Promise<AiProvidersView> {
  const row = await loadConfig(ctx);
  const doc = parseConfigDoc(row.providersJson);
  const keys = decryptKeyMap(row.configEnc);
  const info = AI_PROVIDERS[input.kind];
  const existing = doc.providers.find((p) => p.kind === input.kind);
  const baseUrl = input.baseUrl?.trim().replace(/\/+$/, '') || existing?.baseUrl || null;
  const live = withLiveEngines(ctx, { ...doc, providers: [] }).providers.find((p) => p.kind === input.kind);
  if (!info.defaultBaseUrl && !baseUrl && input.kind !== 'bedrock' && !live) {
    throw commandRejected(`${info.label} needs a base URL`);
  }
  if (baseUrl) {
    // SSRF: the gateway sends the org's credential here — public hosts only,
    // or one of the org's own in-cluster engines.
    const check = await checkProviderUrl(baseUrl, { allowHosts: inClusterHosts(ctx), resolve: hostResolver });
    if (!check.ok) throw commandRejected(`${info.label} base URL refused: ${check.reason}`);
  }
  if (input.kind === 'bedrock' && !(input.region ?? existing?.region)) {
    throw commandRejected('AWS Bedrock needs a region (e.g. us-east-1)');
  }
  if (input.kind === 'bedrock' && input.apiKey && !/^[^:\s]+:[^:\s]+(:.+)?$/.test(input.apiKey.trim()) && input.apiKey.includes(':')) {
    throw commandRejected('Bedrock credentials are ACCESS_KEY_ID:SECRET_ACCESS_KEY[:SESSION_TOKEN] or a Bedrock API key');
  }
  const next: AiProviderDescriptor = {
    kind: input.kind,
    baseUrl,
    isDefault: input.makeDefault || existing?.isDefault === true,
    ...((input.region ?? existing?.region) ? { region: input.region ?? existing?.region } : {}),
    ...((input.apiVersion ?? existing?.apiVersion) ? { apiVersion: input.apiVersion ?? existing?.apiVersion } : {}),
    ...((input.deployments ?? existing?.deployments) ? { deployments: input.deployments ?? existing?.deployments } : {}),
  };
  doc.providers = [...doc.providers.filter((p) => p.kind !== input.kind), next];
  if (input.makeDefault) {
    for (const p of doc.providers) p.isDefault = p.kind === input.kind;
  }
  if (!doc.providers.some((p) => p.isDefault) && doc.providers.length > 0) {
    doc.providers[0]!.isDefault = true;
  }
  // A new origin without a new key drops the stored one (re-enter it).
  const keyDropped =
    !input.apiKey && Boolean(keys[input.kind]) && !keepsStoredKey(input.kind, existing?.baseUrl ?? null, next.baseUrl);
  if (keyDropped) delete keys[input.kind];
  if (input.apiKey) keys[input.kind] = input.apiKey.trim();
  await saveConfig(ctx, doc, Object.keys(keys).length > 0 ? encryptSecret(JSON.stringify(keys)) : null);
  await writeAudit(ctx, {
    action: 'ai.provider.set',
    targetType: 'aiProvider',
    targetId: input.kind,
    metadata: {
      baseUrl: next.baseUrl,
      previousBaseUrl: existing?.baseUrl ?? null,
      region: next.region ?? null,
      keyUpdated: Boolean(input.apiKey),
      keyDropped,
      makeDefault: input.makeDefault,
    },
  });
  return getProviders(ctx);
}

export async function removeProvider(ctx: OrgContext, kind: AiProviderKind): Promise<AiProvidersView> {
  const row = await loadConfig(ctx);
  const doc = parseConfigDoc(row.providersJson);
  const keys = decryptKeyMap(row.configEnc);
  doc.providers = doc.providers.filter((p) => p.kind !== kind);
  delete keys[kind];
  if (!doc.providers.some((p) => p.isDefault) && doc.providers.length > 0) {
    doc.providers[0]!.isDefault = true;
  }
  await saveConfig(ctx, doc, Object.keys(keys).length > 0 ? encryptSecret(JSON.stringify(keys)) : null);
  await writeAudit(ctx, { action: 'ai.provider.remove', targetType: 'aiProvider', targetId: kind });
  return getProviders(ctx);
}

/**
 * "Test" button: one cheap upstream check with the stored credential, run by
 * the data plane's probe (the same adapters, SigV4 included) — a free model
 * list where the provider has one, else a 1-token chat on its cheapest model.
 */
export async function testProvider(ctx: OrgContext, kind: AiProviderKind): Promise<AiTestResult> {
  const probe = aiProviderProbe();
  if (!probe) throw commandRejected('the AI gateway is not running in this process');
  const doc = withLiveEngines(ctx, parseConfigDoc((await loadConfig(ctx)).providersJson));
  if (!doc.providers.some((p) => p.kind === kind)) throw notFound('AI provider', kind);
  const r = await probe(ctx.activeOrgId, kind);
  await writeAudit(ctx, {
    action: 'ai.provider.test',
    targetType: 'aiProvider',
    targetId: kind,
    metadata: { ok: r.ok, latencyMs: r.latencyMs },
  });
  return r;
}

// ── Routes, models, per-app allowlists ───────────────────────────────────────

/** Catalogue + routes as the gateway resolves them now (for pickers and the playground). */
export async function listModels(ctx: OrgContext): Promise<AiModelsView> {
  const doc = withLiveEngines(ctx, parseConfigDoc((await loadConfig(ctx)).providersJson));
  const configured = doc.providers.map((p) => p.kind);
  const routes = effectiveRoutes(doc, configured);
  const models: AiModelOptionView[] = [];
  for (const [name, r] of Object.entries(routes)) {
    const first = r.targets[0];
    const price = first ? modelPrice(first.model, first.provider) : { inUsd: 0, outUsd: 0 };
    const cat = first ? MODEL_CATALOG.find((m) => m.id === first.model) : undefined;
    models.push({
      name,
      kind: cat?.kind ?? (name === 'embed' ? 'embed' : 'chat'),
      source: 'alias',
      providers: [...new Set(r.targets.map((t) => t.provider))],
      ...price,
    });
  }
  for (const m of MODEL_CATALOG) {
    if (!configured.includes(m.provider)) continue;
    const name = m.provider === 'ollama' || m.provider === 'vllm' || m.provider === 'openrouter' || m.provider === 'groq' ? `${m.provider}/${m.id}` : m.id;
    if (models.some((x) => x.name === name)) continue;
    models.push({ name, kind: m.kind, source: 'model', providers: [m.provider], inUsd: m.inUsd, outUsd: m.outUsd });
  }
  return { models, routes, apps: doc.apps };
}

export async function setRoute(ctx: OrgContext, input: SetAiRouteInput): Promise<AiModelsView> {
  const row = await loadConfig(ctx);
  const doc = parseConfigDoc(row.providersJson);
  doc.routes[input.name] = {
    strategy: input.strategy,
    targets: input.targets.map((t) => ({ provider: t.provider, model: t.model, ...(t.weight ? { weight: t.weight } : {}) })),
  };
  await saveConfig(ctx, doc, row.configEnc);
  await writeAudit(ctx, {
    action: 'ai.route.set',
    targetType: 'aiRoute',
    targetId: input.name,
    metadata: { strategy: input.strategy, targets: input.targets.map((t) => `${t.provider}/${t.model}`) },
  });
  return listModels(ctx);
}

export async function removeRoute(ctx: OrgContext, name: string): Promise<AiModelsView> {
  const row = await loadConfig(ctx);
  const doc = parseConfigDoc(row.providersJson);
  if (!doc.routes[name]) throw notFound('AI route', name);
  delete doc.routes[name];
  await saveConfig(ctx, doc, row.configEnc);
  await writeAudit(ctx, { action: 'ai.route.remove', targetType: 'aiRoute', targetId: name });
  return listModels(ctx);
}

export async function setAppModels(ctx: OrgContext, input: SetAiAppModelsInput): Promise<AiModelsView> {
  const row = await loadConfig(ctx);
  const doc = parseConfigDoc(row.providersJson);
  if (input.models.length) doc.apps[input.stack] = { models: [...new Set(input.models)] };
  else delete doc.apps[input.stack];
  await saveConfig(ctx, doc, row.configEnc);
  await writeAudit(ctx, { action: 'ai.appModels.set', targetType: 'stack', targetId: input.stack, metadata: { models: input.models } });
  return listModels(ctx);
}

/**
 * ABAC `ai.use` on each concrete allowlist entry for the minter — a member
 * can't mint a key for a model policy forbids them. Wildcards are checked as
 * the literal pattern (a policy may name `*` or `provider/*`).
 */
async function assertMayUseModels(ctx: OrgContext, models: readonly string[]): Promise<void> {
  if (!models.length) return;
  const doc = withLiveEngines(ctx, parseConfigDoc((await loadConfig(ctx)).providersJson));
  for (const name of models) {
    const resolved = resolveModel(name, doc) ?? { requested: name, alias: null, strategy: 'fallback' as const, targets: [] };
    const d = await evaluateAccess(ctx, 'ai.use', aiModelResource(ctx.activeOrgId, resolved));
    if (d.decision !== 'permit') throw policyDenied('ai.use', d.policyId);
  }
}

// ── Virtual keys ──────────────────────────────────────────────────────────────

/** `swk-ai-…` — the gateway virtual-key format (stored only as sha-256). */
export function generateVirtualKey(): string {
  return `swk-ai-${randomBytes(24).toString('base64url')}`;
}

export async function listKeys(ctx: OrgContext): Promise<AiKeyView[]> {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const [rows, usage] = await Promise.all([
    ctx.db.aiVirtualKey.findMany({ where: { orgId: ctx.activeOrgId }, orderBy: { createdAt: 'desc' } }),
    ctx.db.aiUsage.groupBy({
      by: ['keyId'],
      where: { orgId: ctx.activeOrgId, at: { gte: since } },
      _count: { _all: true },
      _sum: { costMicros: true },
    }),
  ]);
  const byKey = new Map(usage.map((u) => [u.keyId, u]));
  return rows.map((k) => {
    const u = byKey.get(k.id);
    return {
      id: k.id,
      name: k.name,
      appRef: k.appRef,
      disabled: k.disabled,
      createdAt: k.createdAt.toISOString(),
      limits: parseKeyLimits(k.limitsJson),
      usage30d: {
        requests: u?._count._all ?? 0,
        costUsd: Number(u?._sum.costMicros ?? 0n) * USD_PER_MICRO,
      },
    };
  });
}

/** Key policy document for `limitsJson` (only set fields). */
export function keyPolicyJson(i: {
  rpm?: number | null;
  dailyBudgetUsd?: number | null;
  models?: readonly string[] | null;
  maxPromptTokens?: number | null;
  budgetScope?: 'key' | 'app';
  mintedBy?: string | null;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (i.rpm) out.rpm = i.rpm;
  if (i.dailyBudgetUsd) out.dailyBudgetMicros = Math.round(i.dailyBudgetUsd * 1_000_000);
  if (i.budgetScope === 'app') out.budgetScope = 'app';
  if (i.models && i.models.length) out.models = [...new Set(i.models)];
  if (i.maxPromptTokens) out.maxPromptTokens = i.maxPromptTokens;
  if (i.mintedBy) out.mintedBy = i.mintedBy;
  return out;
}

export async function mintKey(
  ctx: OrgContext,
  input: MintAiKeyInput & { budgetScope?: 'key' | 'app' },
): Promise<AiKeyMintResult> {
  const name = input.name.trim();
  const existing = await ctx.db.aiVirtualKey.findFirst({
    where: { orgId: ctx.activeOrgId, name },
    select: { id: true },
  });
  if (existing) throw commandRejected(`a key named "${name}" already exists`);
  await assertMayUseModels(ctx, input.models ?? []);
  const key = generateVirtualKey();
  const limitsJson = keyPolicyJson({ ...input, mintedBy: ctx.user?.id ?? null }) as object;
  const row = await ctx.db.aiVirtualKey.create({
    data: {
      orgId: ctx.activeOrgId,
      name,
      keyHash: hashToken(key),
      appRef: input.appRef?.trim() || null,
      limitsJson,
    },
  });
  await writeAudit(ctx, {
    action: 'ai.key.mint',
    targetType: 'aiVirtualKey',
    targetId: row.id,
    metadata: { name, rpm: input.rpm ?? null, dailyBudgetUsd: input.dailyBudgetUsd ?? null, models: input.models ?? null },
  });
  return { id: row.id, name, key, gatewayUrl: gatewayUrl() };
}

/** Edit a key's allowlist/limits in place — the plaintext is untouched (no rotation). */
export async function updateKey(ctx: OrgContext, input: UpdateAiKeyInput): Promise<AiKeyView> {
  const row = await ctx.db.aiVirtualKey.findFirst({ where: { id: input.id, orgId: ctx.activeOrgId } });
  if (!row) throw notFound('AI key', input.id);
  const cur = parseKeyPolicy(row.limitsJson);
  if (input.models) await assertMayUseModels(ctx, input.models);
  const pick = <T>(v: T | null | undefined, keep: T | null): T | null => (v === undefined ? keep : v);
  const limitsJson = keyPolicyJson({
    rpm: pick(input.rpm, cur.rpm),
    dailyBudgetUsd: pick(input.dailyBudgetUsd, cur.dailyBudgetMicros !== null ? cur.dailyBudgetMicros * USD_PER_MICRO : null),
    models: pick(input.models, cur.models),
    maxPromptTokens: pick(input.maxPromptTokens, cur.maxPromptTokens),
    budgetScope: cur.budgetScope,
    mintedBy: cur.mintedBy,
  }) as object;
  await ctx.db.aiVirtualKey.update({ where: { id: row.id }, data: { limitsJson } });
  await writeAudit(ctx, {
    action: 'ai.key.update',
    targetType: 'aiVirtualKey',
    targetId: row.id,
    metadata: { name: row.name, ...input, id: undefined },
  });
  const views = await listKeys(ctx);
  return views.find((k) => k.id === row.id)!;
}

export async function revokeKey(ctx: OrgContext, id: string): Promise<{ id: string; disabled: true }> {
  const row = await ctx.db.aiVirtualKey.findFirst({ where: { id, orgId: ctx.activeOrgId } });
  if (!row) throw notFound('AI key', id);
  await ctx.db.aiVirtualKey.update({ where: { id: row.id }, data: { disabled: true } });
  await writeAudit(ctx, {
    action: 'ai.key.revoke',
    targetType: 'aiVirtualKey',
    targetId: row.id,
    metadata: { name: row.name },
  });
  return { id: row.id, disabled: true };
}

// ── Playground ────────────────────────────────────────────────────────────────

/**
 * Try a model under one key's limits: the request runs through the gateway's
 * own pipeline in-process (allowlists, ABAC `ai.use` for the CURRENT member,
 * prompt cap, RPM, budget, fallbacks) and is metered + traced like any call.
 */
export async function runPlayground(ctx: OrgContext, input: AiPlaygroundInput): Promise<AiPlaygroundResult> {
  const run = aiGatewayRunner();
  if (!run) throw commandRejected('the AI gateway is not running in this process');
  const key = await ctx.db.aiVirtualKey.findFirst({ where: { id: input.keyId, orgId: ctx.activeOrgId } });
  if (!key) throw notFound('AI key', input.keyId);
  const embed = input.input !== undefined && input.messages.length === 0;
  const body: Record<string, unknown> = embed
    ? { model: input.model, input: input.input }
    : {
        model: input.model,
        messages: input.messages,
        max_tokens: input.maxTokens,
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      };
  const out = await run({
    orgId: ctx.activeOrgId,
    keyId: key.id,
    userId: ctx.user.id,
    path: embed ? '/v1/embeddings' : '/v1/chat/completions',
    body,
  });
  const j = (out.json ?? {}) as {
    error?: { message?: string };
    choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ function: { name: string; arguments: string } }> } }>;
    data?: Array<{ embedding?: number[] }>;
  };
  const msg = j.choices?.[0]?.message;
  const text = embed
    ? `${j.data?.length ?? 0} embedding(s) · ${j.data?.[0]?.embedding?.length ?? 0} dimensions`
    : (msg?.content ?? '');
  await writeAudit(ctx, {
    action: 'ai.playground.run',
    targetType: 'aiVirtualKey',
    targetId: key.id,
    metadata: { model: input.model, status: out.status, provider: out.provider },
  });
  return {
    ok: out.status < 400,
    status: out.status,
    model: out.model ?? input.model,
    provider: out.provider,
    text,
    toolCalls: (msg?.tool_calls ?? []).map((t) => ({ name: t.function.name, arguments: t.function.arguments })),
    inTokens: out.inTokens,
    outTokens: out.outTokens,
    costUsd: out.costMicros * USD_PER_MICRO,
    latencyMs: out.latencyMs,
    attempts: out.attempts,
    traceId: out.traceId,
    error: out.status >= 400 ? (j.error?.message ?? `HTTP ${out.status}`) : null,
  };
}

// ── Usage & logs ──────────────────────────────────────────────────────────────

interface UsageRowLite {
  at: Date;
  model: string;
  keyName: string;
  inTokens: number;
  outTokens: number;
  costMicros: bigint;
  latencyMs: number;
  cacheHit: boolean;
}

/** Pure aggregation: rows → day buckets + model/key breakdowns (tested). */
export function aggregateUsage(rows: UsageRowLite[], days: number, now: Date): AiUsageSummaryView {
  const dayKey = (d: Date): string => d.toISOString().slice(0, 10);
  const dayBuckets = new Map<string, AiUsageDayView>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    dayBuckets.set(dayKey(d), { day: dayKey(d), requests: 0, inTokens: 0, outTokens: 0, costUsd: 0 });
  }
  const byModel = new Map<string, AiUsageBreakdownRow>();
  const byKey = new Map<string, AiUsageBreakdownRow>();
  const totals = { requests: 0, inTokens: 0, outTokens: 0, costUsd: 0, cacheHits: 0, avgLatencyMs: 0 };
  let latencySum = 0;

  const bump = (m: Map<string, AiUsageBreakdownRow>, key: string, r: UsageRowLite, usd: number): void => {
    const row = m.get(key) ?? { key, requests: 0, inTokens: 0, outTokens: 0, costUsd: 0 };
    row.requests += 1;
    row.inTokens += r.inTokens;
    row.outTokens += r.outTokens;
    row.costUsd += usd;
    m.set(key, row);
  };

  for (const r of rows) {
    const usd = Number(r.costMicros) * USD_PER_MICRO;
    const bucket = dayBuckets.get(dayKey(r.at));
    if (bucket) {
      bucket.requests += 1;
      bucket.inTokens += r.inTokens;
      bucket.outTokens += r.outTokens;
      bucket.costUsd += usd;
    }
    bump(byModel, r.model, r, usd);
    bump(byKey, r.keyName, r, usd);
    totals.requests += 1;
    totals.inTokens += r.inTokens;
    totals.outTokens += r.outTokens;
    totals.costUsd += usd;
    if (r.cacheHit) totals.cacheHits += 1;
    latencySum += r.latencyMs;
  }
  totals.avgLatencyMs = totals.requests > 0 ? Math.round(latencySum / totals.requests) : 0;
  const desc = (a: AiUsageBreakdownRow, b: AiUsageBreakdownRow): number => b.costUsd - a.costUsd || b.requests - a.requests;
  return {
    days: [...dayBuckets.values()],
    byModel: [...byModel.values()].sort(desc),
    byKey: [...byKey.values()].sort(desc),
    totals,
    costIsEstimate: true,
  };
}

export async function usageSummary(ctx: OrgContext, input: AiUsageInput): Promise<AiUsageSummaryView> {
  const now = new Date();
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (input.days - 1)));
  const rows = await ctx.db.aiUsage.findMany({
    where: {
      orgId: ctx.activeOrgId,
      at: { gte: since },
      ...(input.keyId ? { keyId: input.keyId } : {}),
    },
    include: { key: { select: { name: true } } },
    orderBy: { at: 'asc' },
    take: 50_000,
  });
  return aggregateUsage(
    rows.map((r) => ({
      at: r.at,
      model: r.model,
      keyName: r.key.name,
      inTokens: r.inTokens,
      outTokens: r.outTokens,
      costMicros: r.costMicros,
      latencyMs: r.latencyMs,
      cacheHit: r.cacheHit,
    })),
    input.days,
    now,
  );
}

export async function listLogs(ctx: OrgContext, input: AiLogsInput): Promise<AiRequestLogView[]> {
  const rows = await ctx.db.aiRequestLog.findMany({
    where: { orgId: ctx.activeOrgId, ...(input.keyId ? { keyId: input.keyId } : {}) },
    include: { key: { select: { name: true } } },
    orderBy: { at: 'desc' },
    take: input.limit,
  });
  return rows.map((r) => {
    const meta = (r.meta ?? {}) as Record<string, unknown>;
    const num = (k: string): number => (typeof meta[k] === 'number' ? (meta[k] as number) : 0);
    return {
      id: r.id,
      at: r.at.toISOString(),
      keyName: r.key.name,
      model: r.model,
      provider: typeof meta.provider === 'string' ? (meta.provider as string) : 'unknown',
      status: typeof meta.status === 'string' ? (meta.status as string) : 'ok',
      latencyMs: num('latencyMs'),
      inTokens: num('inTokens'),
      outTokens: num('outTokens'),
      costUsd: num('costMicros') * USD_PER_MICRO,
      cacheHit: meta.cacheHit === true,
      promptRedacted: r.promptRedacted,
    };
  });
}

// ── Settings ──────────────────────────────────────────────────────────────────

export async function getSettings(ctx: OrgContext): Promise<AiSettingsView> {
  return parseConfigDoc((await loadConfig(ctx)).providersJson).settings;
}

export async function setSettings(ctx: OrgContext, input: AiSettingsInput): Promise<AiSettingsView> {
  const row = await loadConfig(ctx);
  const doc = parseConfigDoc(row.providersJson);
  if (input.auditLog !== undefined) doc.settings.auditLog = input.auditLog;
  if (input.cache !== undefined) doc.settings.cache = input.cache;
  if (input.guardrails?.redactPii !== undefined) doc.settings.guardrails.redactPii = input.guardrails.redactPii;
  if (input.guardrails?.maxPromptTokens !== undefined) doc.settings.guardrails.maxPromptTokens = input.guardrails.maxPromptTokens;
  await saveConfig(ctx, doc, row.configEnc);
  await writeAudit(ctx, { action: 'ai.settings.set', targetType: 'aiSettings', metadata: { ...doc.settings } });
  return doc.settings;
}

// ── Attach: inject AI_GATEWAY_URL + a per-app key via Docker secret ───────────

/** Docker secret carrying an app's virtual key. */
export function aiKeySecretName(stack: string, appService: string): string {
  return `swarmy-ai-${stack}_${appService}-key`;
}

/**
 * Wire an app service to the gateway: mint a dedicated virtual key, put it in a
 * Docker secret, and redeploy the app with `AI_GATEWAY_URL` +
 * `AI_GATEWAY_KEY_FILE` pointing at the mounted secret. Re-attaching rotates
 * the key (the old one is revoked). The plaintext key never leaves Docker.
 */
export async function attachAiToService(ctx: OrgContext, input: AttachAiInput): Promise<AiAttachResult> {
  const providers = await getProviders(ctx);
  if (!providers.providers.some((p) => p.hasKey)) {
    throw commandRejected('no AI provider configured — add one on the AI page first');
  }
  const app = liveOrgServices(ctx).find(
    (s) => s.stack === input.stack && (s.id === input.appService || s.name === input.appService),
  );
  if (!app) throw notFound('service', input.appService);

  const appRef = `${input.stack}/${app.name}`;
  const keyName = `svc:${appRef}`;
  // Rotate: retire any previous key minted for this app.
  const prior = await ctx.db.aiVirtualKey.findFirst({ where: { orgId: ctx.activeOrgId, name: keyName } });
  if (prior) {
    await ctx.db.aiVirtualKey.update({
      where: { id: prior.id },
      data: { disabled: true, name: `${keyName} (rotated ${Date.now()})` },
    });
  }
  const minted = await mintKey(ctx, { name: keyName, appRef });

  const node = await resolveManagerNode(ctx);
  const secretName = aiKeySecretName(input.stack, app.name);
  const dataB64 = Buffer.from(minted.key, 'utf8').toString('base64');
  const secretLabels = { [MANAGED_LABEL]: 'true', [AI_INJECT_LABEL]: 'true' };
  try {
    try {
      await ctx.hub.dispatch(node.id, 'secret.create', { name: secretName, dataB64, labels: secretLabels });
    } catch (e) {
      if (!/already exists|conflict/i.test(e instanceof Error ? e.message : String(e))) throw e;
      await ctx.hub.dispatch(node.id, 'secret.remove', { name: secretName });
      await ctx.hub.dispatch(node.id, 'secret.create', { name: secretName, dataB64, labels: secretLabels });
    }

    // One-aspect patch over the FULL live spec — volumes/command/placement survive.
    await patchLiveService(
      ctx,
      app,
      {
        setEnv: { [AI_ENV_VAR]: minted.gatewayUrl, [AI_KEY_FILE_VAR]: `/run/secrets/${secretName}` },
        addSecrets: [{ source: secretName }],
        setLabels: {
          [STACK_LABEL]: input.stack,
          [AI_INJECT_LABEL]: 'true',
          [AI_INJECT_KEY_LABEL]: keyName,
        },
      },
      { nodeId: node.id },
    );
  } catch (e) {
    throw mapDispatchError(e);
  }
  await writeAudit(ctx, {
    action: 'ai.attach',
    targetType: 'service',
    targetId: app.name,
    metadata: { stack: input.stack, keyName, secret: secretName },
  });
  return {
    appService: app.name,
    keyName,
    gatewayUrl: minted.gatewayUrl,
    envVar: AI_ENV_VAR,
    keyFileVar: AI_KEY_FILE_VAR,
    keySecret: secretName,
  };
}

// ── Stack access: one grant per stack (key + attached services + outlet) ──────

/** Virtual-key name carrying a stack-wide grant (`stack:<name>`). */
export function stackKeyName(stack: string): string {
  return `stack:${stack}`;
}

export interface AiStackKeySummary {
  id: string;
  name: string;
  createdAt: string;
  limits: AiKeyLimitsView;
}

export interface AiStackAttachedService {
  service: string;
  keyName: string;
}

/** The stack's current AI grant: key (hash-only), wired services, outlet. */
export interface AiStackAccessView {
  stack: string;
  key: AiStackKeySummary | null;
  attachedServices: AiStackAttachedService[];
  outletDomain: string | null;
  gatewayUrl: string;
}

export interface AiStackGrantResult {
  stack: string;
  keyId: string;
  keyName: string;
  /** Plaintext virtual key — returned ONCE, then stored only as a hash. */
  key: string;
  gatewayUrl: string;
  attached: AiAttachResult[];
}

export interface AiOutletView {
  stack: string;
  domain: string;
}

/** Current grant for one stack: stack key + label-attached services + outlet. */
export async function stackAccess(ctx: OrgContext, stack: string): Promise<AiStackAccessView> {
  const [keyRow, row] = await Promise.all([
    ctx.db.aiVirtualKey.findFirst({
      where: { orgId: ctx.activeOrgId, name: stackKeyName(stack), disabled: false },
      orderBy: { createdAt: 'desc' },
    }),
    loadConfig(ctx),
  ]);
  const attachedServices: AiStackAttachedService[] = liveOrgServices(ctx)
    .filter((s) => s.stack === stack && s.labels[AI_INJECT_LABEL] === 'true')
    .map((s) => ({
      service: s.name,
      keyName: s.labels[AI_INJECT_KEY_LABEL] ?? `svc:${stack}/${s.name}`,
    }))
    .sort((a, b) => a.service.localeCompare(b.service));
  return {
    stack,
    key: keyRow
      ? {
          id: keyRow.id,
          name: keyRow.name,
          createdAt: keyRow.createdAt.toISOString(),
          limits: parseKeyLimits(keyRow.limitsJson),
        }
      : null,
    attachedServices,
    outletDomain: parseConfigDoc(row.providersJson).outlets[stack] ?? null,
    gatewayUrl: gatewayUrl(),
  };
}

/**
 * Grant a stack AI access: mint a stack-tagged virtual key (revealed ONCE; an
 * existing grant is rotated) and wire each chosen service through the normal
 * attach flow (per-service key in a Docker secret + gateway env).
 */
export async function grantStackAccess(
  ctx: OrgContext,
  input: { stack: string; services?: string[] },
): Promise<AiStackGrantResult> {
  const providers = await getProviders(ctx);
  if (!providers.providers.some((p) => p.hasKey)) {
    throw commandRejected('no AI provider configured — add one on the AI page first');
  }
  const name = stackKeyName(input.stack);
  const prior = await ctx.db.aiVirtualKey.findFirst({
    where: { orgId: ctx.activeOrgId, name },
    select: { id: true },
  });
  if (prior) {
    await ctx.db.aiVirtualKey.update({
      where: { id: prior.id },
      data: { disabled: true, name: `${name} (rotated ${Date.now()})` },
    });
  }
  const minted = await mintKey(ctx, { name, appRef: input.stack });
  const attached: AiAttachResult[] = [];
  for (const svc of input.services ?? []) {
    attached.push(await attachAiToService(ctx, { stack: input.stack, appService: svc }));
  }
  await writeAudit(ctx, {
    action: 'ai.stackAccess.grant',
    targetType: 'stack',
    targetId: input.stack,
    metadata: { keyName: name, rotated: Boolean(prior), services: attached.map((a) => a.appService) },
  });
  return {
    stack: input.stack,
    keyId: minted.id,
    keyName: name,
    key: minted.key,
    gatewayUrl: minted.gatewayUrl,
    attached,
  };
}

/**
 * Revoke the stack's grant: disable the stack-tagged key AND every per-service
 * key minted for the stack. The gateway answers 403 immediately; injected env
 * on services stays until their next redeploy (harmless — the key is dead).
 */
export async function revokeStackAccess(
  ctx: OrgContext,
  stack: string,
): Promise<{ stack: string; revoked: number }> {
  const res = await ctx.db.aiVirtualKey.updateMany({
    where: {
      orgId: ctx.activeOrgId,
      disabled: false,
      OR: [{ name: stackKeyName(stack) }, { appRef: stack }, { appRef: { startsWith: `${stack}/` } }],
    },
    data: { disabled: true },
  });
  await writeAudit(ctx, {
    action: 'ai.stackAccess.revoke',
    targetType: 'stack',
    targetId: stack,
    metadata: { revoked: res.count },
  });
  return { stack, revoked: res.count };
}

/**
 * Point a public domain at this stack's gateway (empty domain clears it).
 * Persisted in the org-config JSON (`providersJson.outlets`); the edge reads
 * {@link listOutlets} to render one vhost per entry.
 */
export async function setStackOutlet(
  ctx: OrgContext,
  input: { stack: string; domain: string },
): Promise<{ stack: string; domain: string | null }> {
  const row = await loadConfig(ctx);
  const doc = parseConfigDoc(row.providersJson);
  const domain = input.domain.trim().toLowerCase();
  const taken = Object.entries(doc.outlets).find(([s, d]) => d === domain && s !== input.stack);
  if (domain && taken) {
    throw commandRejected(`"${domain}" already routes to the ${taken[0]} stack`);
  }
  if (domain) {
    // Cross-feature guard (queried directly — ingress.service imports this
    // module, so importing its helper here would create a cycle): a hostname
    // renders exactly one controller vhost, shared with status pages/webhooks.
    const [page, endpoint] = await Promise.all([
      ctx.db.statusPage.findFirst({
        where: { orgId: ctx.activeOrgId, domain },
        select: { slug: true },
      }),
      ctx.db.inboundEndpoint.findFirst({
        where: { orgId: ctx.activeOrgId, domain },
        select: { slug: true },
      }),
    ]);
    if (page) throw commandRejected(`"${domain}" is already used by status page "${page.slug}"`);
    if (endpoint) {
      throw commandRejected(`"${domain}" is already used by webhook endpoint "${endpoint.slug}"`);
    }
  }
  if (domain) doc.outlets[input.stack] = domain;
  else delete doc.outlets[input.stack];
  await saveConfig(ctx, doc, row.configEnc);
  await writeAudit(ctx, {
    action: 'ai.outlet.set',
    targetType: 'stack',
    targetId: input.stack,
    metadata: { domain: domain || null },
  });
  return { stack: input.stack, domain: domain || null };
}

/** Every stack outlet, sorted — the edge renders one gateway vhost per entry. */
export async function listOutlets(ctx: OrgContext): Promise<AiOutletView[]> {
  const doc = parseConfigDoc((await loadConfig(ctx)).providersJson);
  return Object.entries(doc.outlets)
    .map(([stack, domain]) => ({ stack, domain }))
    .sort((a, b) => a.stack.localeCompare(b.stack));
}

// ── swarmy.yaml `ai:` binding ─────────────────────────────────────────────────

/** Marker on an app service bound through swarmy.yaml `ai:` (value = the key name). */
export const AI_BIND_LABEL = 'swarmy.ai.bind';
/** Env the binding sets (addressing — safe in the spec). */
export const AI_BIND_ENV = ['OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL', AI_ENV_VAR] as const;
/**
 * Secret variables the binding mounts (the same virtual key under each SDK's
 * own name), delivered by the app-secrets env shim: Docker secrets
 * `<service>_<KEY>_v<N>`, exported at start, never in the spec.
 */
export const AI_BIND_SECRET_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'] as const;

export interface AiBindInput {
  stack: string;
  appService: string;
  /** Model allowlist from swarmy.yaml (`ai.models`). */
  models: readonly string[];
  /** App-wide daily budget in USD (`ai.budget: 5/day`), shared by the app's keys. */
  dailyBudgetUsd?: number | null;
  rpm?: number | null;
}

export interface AiBindResult {
  appService: string;
  keyName: string;
  rotated: boolean;
  env: Record<string, string>;
  secretVars: string[];
}

/** Key name for a swarmy.yaml binding (`app:<stack>/<service>`). */
export function bindKeyName(stack: string, service: string): string {
  return `app:${stack}/${service}`;
}

/**
 * Bind an app service to the gateway from swarmy.yaml: one key per service
 * (allowlist = `ai.models`, the budget shared app-wide), `OPENAI_BASE_URL` +
 * `ANTHROPIC_BASE_URL` + `AI_GATEWAY_URL` in env, and the key as the secret
 * variables `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` (Docker secrets via the
 * env shim — `carrySecretVars` keeps them across every later compose deploy).
 *
 * Re-binding with a changed allowlist/budget updates the key's policy in
 * place; the key only rotates when its secret is no longer mounted.
 */
export async function bindAiToService(ctx: OrgContext, input: AiBindInput): Promise<AiBindResult> {
  const providers = await getProviders(ctx);
  if (!providers.providers.some((p) => p.hasKey)) {
    throw commandRejected('ai: in swarmy.yaml needs an AI provider — add one on the AI page first');
  }
  const app = liveOrgServices(ctx).find(
    (s) => s.stack === input.stack && (s.id === input.appService || s.name === input.appService),
  );
  if (!app) throw notFound('service', input.appService);
  const keyName = bindKeyName(input.stack, app.name);
  const appRef = `${input.stack}/${app.name}`;
  const node = await resolveManagerNode(ctx);
  const owned = versionsOf(await listAppSecretVersions(ctx, node.id), app.name);
  const mounted = mountedVersions(owned, app.secrets ?? []);
  const policy = keyPolicyJson({
    rpm: input.rpm ?? null,
    dailyBudgetUsd: input.dailyBudgetUsd ?? null,
    models: input.models,
    budgetScope: 'app',
    mintedBy: ctx.user?.id ?? null,
  }) as object;

  const prior = await ctx.db.aiVirtualKey.findFirst({ where: { orgId: ctx.activeOrgId, name: keyName } });
  const stillMounted = AI_BIND_SECRET_KEYS.every((k) => mounted.has(k));
  let rotated = false;
  let plaintext: string | null = null;
  await assertMayUseModels(ctx, input.models);
  if (prior && !prior.disabled && stillMounted) {
    await ctx.db.aiVirtualKey.update({ where: { id: prior.id }, data: { limitsJson: policy } });
  } else {
    if (prior) {
      await ctx.db.aiVirtualKey.update({
        where: { id: prior.id },
        data: { disabled: true, name: `${keyName} (rotated ${Date.now()})` },
      });
    }
    plaintext = generateVirtualKey();
    await ctx.db.aiVirtualKey.create({
      data: { orgId: ctx.activeOrgId, name: keyName, keyHash: hashToken(plaintext), appRef, limitsJson: policy },
    });
    rotated = Boolean(prior);
  }

  const env = {
    OPENAI_BASE_URL: gatewayUrl(),
    ANTHROPIC_BASE_URL: anthropicGatewayUrl(),
    [AI_ENV_VAR]: gatewayUrl(),
  };
  try {
    const { desired } = await materializeSecretVars(
      ctx,
      node.id,
      app.name,
      AI_BIND_SECRET_KEYS.map((key) => ({ key, value: plaintext ?? undefined, delivery: 'env' as const })),
      owned,
      mounted,
    );
    await patchLiveService(
      ctx,
      app,
      {
        setEnv: env,
        setLabels: { [STACK_LABEL]: input.stack, [AI_BIND_LABEL]: keyName },
        transform: (spec) => planSecretSpec(spec, owned, { upserts: desired }),
      },
      { nodeId: node.id },
    );
  } catch (e) {
    throw mapDispatchError(e);
  }
  await writeAudit(ctx, {
    action: 'ai.bind',
    targetType: 'service',
    targetId: app.name,
    metadata: { stack: input.stack, keyName, models: input.models, dailyBudgetUsd: input.dailyBudgetUsd ?? null, rotated },
  });
  return { appService: app.name, keyName, rotated, env, secretVars: [...AI_BIND_SECRET_KEYS] };
}
