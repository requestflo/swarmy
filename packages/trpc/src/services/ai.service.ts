import { randomBytes } from 'node:crypto';
import {
  buildInventory,
  STACK_LABEL,
  AI_PROVIDER_KINDS,
  type AiAttachResult,
  type AiKeyLimitsView,
  type AiKeyMintResult,
  type AiKeyView,
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
  AiSettingsInput,
  AiUsageInput,
  AttachAiInput,
  MintAiKeyInput,
  SetAiProviderInput,
} from '@swarmy/core';
import type { ServiceSpec } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { commandRejected, mapDispatchError, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { resolveManagerNode } from './dispatch.service';

/**
 * AI gateway control plane (slice F5) — provider configs, virtual keys,
 * usage/cost queries, request log and settings.
 *
 * Storage split:
 *   - `AiProviderConfig.providersJson` — plain descriptors (kind, baseUrl,
 *     isDefault) + the org settings (audit/cache toggles). NO secrets.
 *   - `AiProviderConfig.configEnc` — vault-encrypted JSON map kind→apiKey.
 *     Keys are write-only: set here, decrypted only by the gateway data plane
 *     (apps/api/src/ai-gateway.ts) at proxy time, never returned to clients.
 *   - `AiVirtualKey.keyHash` — sha-256 of the minted `swk-ai-…` key. The
 *     plaintext is returned exactly once from {@link mintKey}.
 *   - `AiUsage` / `AiRequestLog` — written by the gateway; read here.
 *
 * Attach: the app never sees the org's provider keys — it gets the GATEWAY
 * URL plus its own virtual key mounted as a Docker secret file.
 */

export const GATEWAY_PATH = '/ai/v1';
const CONTROLLER_PUBLIC_URL =
  process.env.CONTROLLER_PUBLIC_URL ?? process.env.BETTER_AUTH_URL ?? 'http://localhost:3001';

export function gatewayUrl(): string {
  return `${CONTROLLER_PUBLIC_URL.replace(/\/+$/, '')}${GATEWAY_PATH}`;
}

/** On an APP service: gateway wiring markers (mirrors swarmy.cache.inject). */
export const AI_INJECT_LABEL = 'swarmy.ai.inject';
export const AI_INJECT_KEY_LABEL = 'swarmy.ai.inject.key';
const MANAGED_LABEL = 'swarmy.managed';

export const AI_ENV_VAR = 'AI_GATEWAY_URL';
export const AI_KEY_FILE_VAR = 'AI_GATEWAY_KEY_FILE';

const USD_PER_MICRO = 1 / 1_000_000;
const TEST_TIMEOUT_MS = 15_000;

// ── Pure: providersJson document codec (tested) ───────────────────────────────

export interface AiProviderDescriptor {
  kind: AiProviderKind;
  baseUrl: string | null;
  isDefault: boolean;
}

export interface AiConfigDoc {
  providers: AiProviderDescriptor[];
  settings: AiSettingsView;
}

const DEFAULT_SETTINGS: AiSettingsView = { auditLog: false, cache: false };

function isKind(v: unknown): v is AiProviderKind {
  return typeof v === 'string' && (AI_PROVIDER_KINDS as readonly string[]).includes(v);
}

/**
 * Parse the `providersJson` column into the config document. Tolerant of the
 * spine default (`[]`), a bare descriptor array, or the `{providers, settings}`
 * wrapper — malformed entries are dropped, never thrown on.
 */
export function parseConfigDoc(raw: unknown): AiConfigDoc {
  const doc: AiConfigDoc = { providers: [], settings: { ...DEFAULT_SETTINGS } };
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { providers?: unknown }).providers)
      ? ((raw as { providers: unknown[] }).providers)
      : [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { kind?: unknown; baseUrl?: unknown; isDefault?: unknown };
    if (!isKind(e.kind)) continue;
    if (doc.providers.some((p) => p.kind === e.kind)) continue;
    doc.providers.push({
      kind: e.kind,
      baseUrl: typeof e.baseUrl === 'string' && e.baseUrl.trim() ? e.baseUrl.trim() : null,
      isDefault: e.isDefault === true,
    });
  }
  const s = (raw as { settings?: unknown } | null | undefined)?.settings;
  if (s && typeof s === 'object') {
    const st = s as { auditLog?: unknown; cache?: unknown };
    doc.settings = { auditLog: st.auditLog === true, cache: st.cache === true };
  }
  // At most one default; the first wins.
  let seenDefault = false;
  for (const p of doc.providers) {
    if (p.isDefault && seenDefault) p.isDefault = false;
    if (p.isDefault) seenDefault = true;
  }
  return doc;
}

/** Parse `AiVirtualKey.limitsJson` → typed limits (invalid values → null). */
export function parseKeyLimits(raw: unknown): AiKeyLimitsView {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const rpm = typeof o.rpm === 'number' && Number.isFinite(o.rpm) && o.rpm > 0 ? Math.floor(o.rpm) : null;
  const micros =
    typeof o.dailyBudgetMicros === 'number' && Number.isFinite(o.dailyBudgetMicros) && o.dailyBudgetMicros > 0
      ? o.dailyBudgetMicros
      : null;
  return { rpm, dailyBudgetUsd: micros !== null ? micros * USD_PER_MICRO : null };
}

/** Decrypt the provider key map from `configEnc` ({} when unset/undecryptable). */
function decryptKeyMap(configEnc: string | null): Partial<Record<AiProviderKind, string>> {
  if (!configEnc) return {};
  try {
    const parsed = JSON.parse(decryptSecret(configEnc)) as Record<string, unknown>;
    const out: Partial<Record<AiProviderKind, string>> = {};
    for (const kind of AI_PROVIDER_KINDS) {
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
  const providersJson = { providers: doc.providers, settings: doc.settings } as object;
  await ctx.db.aiProviderConfig.upsert({
    where: { orgId: ctx.activeOrgId },
    create: { orgId: ctx.activeOrgId, providersJson, configEnc },
    update: { providersJson, configEnc },
  });
}

// ── Providers ─────────────────────────────────────────────────────────────────

export async function getProviders(ctx: OrgContext): Promise<AiProvidersView> {
  const row = await loadConfig(ctx);
  const doc = parseConfigDoc(row.providersJson);
  const keys = decryptKeyMap(row.configEnc);
  const providers: AiProviderView[] = doc.providers.map((p) => ({
    kind: p.kind,
    baseUrl: p.baseUrl,
    hasKey: Boolean(keys[p.kind]),
    isDefault: p.isDefault,
  }));
  return { providers, gatewayUrl: gatewayUrl() };
}

export async function setProvider(ctx: OrgContext, input: SetAiProviderInput): Promise<AiProvidersView> {
  if (input.kind === 'custom' && !input.baseUrl) {
    const existing = parseConfigDoc((await loadConfig(ctx)).providersJson);
    if (!existing.providers.find((p) => p.kind === 'custom')?.baseUrl) {
      throw commandRejected('custom providers need a base URL');
    }
  }
  const row = await loadConfig(ctx);
  const doc = parseConfigDoc(row.providersJson);
  const keys = decryptKeyMap(row.configEnc);

  const existing = doc.providers.find((p) => p.kind === input.kind);
  const next: AiProviderDescriptor = {
    kind: input.kind,
    baseUrl: input.baseUrl?.trim().replace(/\/+$/, '') || existing?.baseUrl || null,
    isDefault: input.makeDefault || existing?.isDefault === true,
  };
  doc.providers = [...doc.providers.filter((p) => p.kind !== input.kind), next];
  if (input.makeDefault) {
    for (const p of doc.providers) p.isDefault = p.kind === input.kind;
  }
  if (!doc.providers.some((p) => p.isDefault) && doc.providers.length > 0) {
    doc.providers[0]!.isDefault = true;
  }
  if (input.apiKey) keys[input.kind] = input.apiKey.trim();
  await saveConfig(ctx, doc, Object.keys(keys).length > 0 ? encryptSecret(JSON.stringify(keys)) : null);
  await writeAudit(ctx, {
    action: 'ai.provider.set',
    targetType: 'aiProvider',
    targetId: input.kind,
    metadata: { baseUrl: next.baseUrl, keyUpdated: Boolean(input.apiKey), makeDefault: input.makeDefault },
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
 * "Test" button: one cheap upstream request with the stored key. Anthropic and
 * OpenAI get a 1-token completion on their cheapest model; custom providers get
 * a `GET /v1/models` probe (model-agnostic, free).
 */
export async function testProvider(ctx: OrgContext, kind: AiProviderKind): Promise<AiTestResult> {
  const row = await loadConfig(ctx);
  const doc = parseConfigDoc(row.providersJson);
  const p = doc.providers.find((x) => x.kind === kind);
  if (!p) throw notFound('AI provider', kind);
  const key = decryptKeyMap(row.configEnc)[kind];
  if (!key) throw commandRejected(`no API key stored for "${kind}" — save one first`);

  const started = Date.now();
  let target = '';
  try {
    let res: Response;
    if (kind === 'anthropic') {
      target = 'claude-haiku-4-5';
      res = await fetch(`${p.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: target,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
        signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      });
    } else if (kind === 'openai') {
      target = 'gpt-4o-mini';
      res = await fetch(`${p.baseUrl ?? 'https://api.openai.com'}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: target,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
        signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      });
    } else {
      if (!p.baseUrl) throw commandRejected('custom provider has no base URL');
      target = `${p.baseUrl}/v1/models`;
      res = await fetch(target, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      });
    }
    const latencyMs = Date.now() - started;
    const ok = res.ok;
    let message: string | null = null;
    if (!ok) {
      const text = await res.text().catch(() => '');
      message = `HTTP ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}`;
    }
    await writeAudit(ctx, {
      action: 'ai.provider.test',
      targetType: 'aiProvider',
      targetId: kind,
      metadata: { ok, latencyMs },
    });
    return { ok, latencyMs, target, message };
  } catch (e) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      target,
      message: e instanceof Error ? e.message : String(e),
    };
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

export async function mintKey(ctx: OrgContext, input: MintAiKeyInput): Promise<AiKeyMintResult> {
  const name = input.name.trim();
  const existing = await ctx.db.aiVirtualKey.findFirst({
    where: { orgId: ctx.activeOrgId, name },
    select: { id: true },
  });
  if (existing) throw commandRejected(`a key named "${name}" already exists`);
  const key = generateVirtualKey();
  const limitsJson: Record<string, number> = {};
  if (input.rpm) limitsJson.rpm = input.rpm;
  if (input.dailyBudgetUsd) limitsJson.dailyBudgetMicros = Math.round(input.dailyBudgetUsd * 1_000_000);
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
    metadata: { name, rpm: input.rpm ?? null, dailyBudgetUsd: input.dailyBudgetUsd ?? null },
  });
  return { id: row.id, name, key, gatewayUrl: gatewayUrl() };
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
  await saveConfig(ctx, doc, row.configEnc);
  await writeAudit(ctx, { action: 'ai.settings.set', targetType: 'aiSettings', metadata: { ...doc.settings } });
  return doc.settings;
}

// ── Attach: inject AI_GATEWAY_URL + a per-app key via Docker secret ───────────

function liveOrgServices(ctx: OrgContext): InvService[] {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  return buildInventory(services, containers).services;
}

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

    const env: Record<string, string> = {};
    for (const kv of app.env) {
      const i = kv.indexOf('=');
      env[i >= 0 ? kv.slice(0, i) : kv] = i >= 0 ? kv.slice(i + 1) : '';
    }
    env[AI_ENV_VAR] = minted.gatewayUrl;
    env[AI_KEY_FILE_VAR] = `/run/secrets/${secretName}`;

    const spec: ServiceSpec = {
      name: app.name,
      image: app.image,
      mode: { replicated: { replicas: app.replicas.desired } },
      labels: {
        ...app.labels,
        [STACK_LABEL]: input.stack,
        [AI_INJECT_LABEL]: 'true',
        [AI_INJECT_KEY_LABEL]: keyName,
      },
      env,
      ports: app.ports.map((p) => ({
        target: p.target,
        published: p.published,
        protocol: p.protocol === 'udp' ? ('udp' as const) : ('tcp' as const),
        mode: 'ingress' as const,
      })),
      networks: app.networks.map((n) => n.name),
      secrets: [
        ...(app.secrets ?? []).filter((n) => n !== secretName).map((n) => ({ source: n })),
        { source: secretName },
      ],
      ...(app.configs && app.configs.length > 0 ? { configs: app.configs.map((n) => ({ source: n })) } : {}),
    };
    await ctx.hub.dispatch(node.id, 'service.deploy', { spec, pullPolicy: 'missing' });
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
