import type {
  AiKeyMintResult,
  AiKeyView,
  AiProviderKind,
  AiProvidersView,
  AiRequestLogView,
  AiSettingsView,
  AiTestResult,
  AiUsageBreakdownRow,
  AiUsageDayView,
  AiUsageSummaryView,
} from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * AI-gateway demo resolvers — the AI surface (`/ai`): providers, virtual keys,
 * usage/cost aggregates, request log and settings. Return shapes mirror
 * `ai.service.ts` views exactly (imported from @swarmy/core, never
 * redeclared). State lives in `store.extra.ai`.
 */

const GATEWAY_URL = 'https://controller.demo.swarmy.dev/ai/v1';

interface AiState {
  providers: AiProvidersView;
  settings: AiSettingsView;
  keys: AiKeyView[];
  /** Seeded per-day usage skeleton (day offsets from "today", newest last). */
  usageDays: AiUsageDayView[];
  byModel: AiUsageBreakdownRow[];
  byKey: AiUsageBreakdownRow[];
  logs: AiRequestLogView[];
  /** Stack → public outlet domain (mirrors providersJson.outlets). */
  outlets: Record<string, string>;
}

/** Stack-tagged grant key name (mirrors ai.service stackKeyName). */
const stackKeyName = (stack: string): string => `stack:${stack}`;

const attachResult = (stack: string, service: string): Record<string, string> => ({
  appService: service,
  keyName: `svc:${stack}/${service}`,
  gatewayUrl: GATEWAY_URL,
  envVar: 'AI_GATEWAY_URL',
  keyFileVar: 'AI_GATEWAY_KEY_FILE',
  keySecret: `swarmy-ai-${stack}_${service}-key`,
});

function getState(store: DemoStore): AiState {
  return store.extra.ai as AiState;
}

const nowIso = (): string => new Date().toISOString();
const dayString = (offset: number): string =>
  new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);

/** Deterministic wobble so charts look organic but stable across reloads. */
const wave = (i: number, base: number, amp: number): number =>
  Math.max(0, Math.round(base + amp * Math.sin(i * 1.7) + (amp / 2) * Math.cos(i * 0.9)));

export const ai: DomainResolvers = {
  seed: (store) => {
    const days: AiUsageDayView[] = [];
    for (let i = 13; i >= 0; i--) {
      const requests = wave(i, 420, 180);
      const inTokens = requests * 950;
      const outTokens = requests * 240;
      days.push({
        day: dayString(i),
        requests,
        inTokens,
        outTokens,
        costUsd: Math.round((inTokens * 3 + outTokens * 15) / 1_000_000 * 100) / 100,
      });
    }
    const totalReq = days.reduce((n, d) => n + d.requests, 0);
    const totalCost = days.reduce((n, d) => n + d.costUsd, 0);

    const logs: AiRequestLogView[] = Array.from({ length: 18 }, (_, i) => {
      const models = ['claude-sonnet-5', 'claude-haiku-4-5', 'gpt-4o-mini', 'text-embedding-3-small'];
      const model = models[i % models.length]!;
      const inTok = wave(i, 900, 500);
      const outTok = model.startsWith('text-embedding') ? 0 : wave(i, 260, 120);
      return {
        id: `demo-log-${i}`,
        at: new Date(Date.now() - i * 7 * 60_000).toISOString(),
        keyName: i % 3 === 0 ? 'worker' : 'web-app',
        model,
        provider: model.startsWith('claude') ? 'anthropic' : 'openai',
        status: i === 7 ? 'error:429' : 'ok',
        latencyMs: wave(i, 850, 420),
        inTokens: inTok,
        outTokens: outTok,
        costUsd: Math.round((inTok * 3 + outTok * 15) / 1_000_000 * 10_000) / 10_000,
        cacheHit: i % 6 === 5,
        promptRedacted:
          i % 4 === 0
            ? 'Summarize the following order history for the customer dashboard: order #48211 shipped…'
            : 'Classify this support ticket into billing / shipping / product: "My parcel arrived damag…',
      };
    });

    store.extra.ai = {
      providers: {
        providers: [
          { kind: 'anthropic', baseUrl: null, hasKey: true, isDefault: true },
          { kind: 'openai', baseUrl: null, hasKey: true, isDefault: false },
        ],
        gatewayUrl: GATEWAY_URL,
      },
      settings: { auditLog: true, cache: true },
      keys: [
        {
          id: 'demo-key-stack-storefront',
          name: 'stack:storefront',
          appRef: 'storefront',
          disabled: false,
          createdAt: new Date(Date.now() - 12 * 86_400_000).toISOString(),
          limits: { rpm: null, dailyBudgetUsd: 25 },
          usage30d: { requests: 0, costUsd: 0 },
        },
        {
          id: 'demo-key-web',
          name: 'web-app',
          appRef: 'storefront/web',
          disabled: false,
          createdAt: new Date(Date.now() - 21 * 86_400_000).toISOString(),
          limits: { rpm: 120, dailyBudgetUsd: 10 },
          usage30d: { requests: Math.round(totalReq * 0.7), costUsd: Math.round(totalCost * 0.7 * 100) / 100 },
        },
        {
          id: 'demo-key-worker',
          name: 'worker',
          appRef: null,
          disabled: false,
          createdAt: new Date(Date.now() - 9 * 86_400_000).toISOString(),
          limits: { rpm: null, dailyBudgetUsd: 2.5 },
          usage30d: { requests: Math.round(totalReq * 0.3), costUsd: Math.round(totalCost * 0.3 * 100) / 100 },
        },
      ],
      usageDays: days,
      byModel: [
        { key: 'claude-sonnet-5', requests: Math.round(totalReq * 0.45), inTokens: 2_610_000, outTokens: 690_000, costUsd: totalCost * 0.62 },
        { key: 'claude-haiku-4-5', requests: Math.round(totalReq * 0.3), inTokens: 1_890_000, outTokens: 410_000, costUsd: totalCost * 0.18 },
        { key: 'gpt-4o-mini', requests: Math.round(totalReq * 0.15), inTokens: 760_000, outTokens: 220_000, costUsd: totalCost * 0.12 },
        { key: 'text-embedding-3-small', requests: Math.round(totalReq * 0.1), inTokens: 1_150_000, outTokens: 0, costUsd: totalCost * 0.08 },
      ],
      byKey: [
        { key: 'web-app', requests: Math.round(totalReq * 0.7), inTokens: 4_480_000, outTokens: 930_000, costUsd: totalCost * 0.7 },
        { key: 'worker', requests: Math.round(totalReq * 0.3), inTokens: 1_930_000, outTokens: 390_000, costUsd: totalCost * 0.3 },
      ],
      logs,
      outlets: { storefront: 'ai.northwind.dev' },
    } satisfies AiState;
  },

  handlers: {
    'ai.providers': (_i, s): AiProvidersView => getState(s).providers,

    'ai.setProvider': (i, s): AiProvidersView => {
      const b = i as { kind: AiProviderKind; apiKey?: string; baseUrl?: string; makeDefault?: boolean };
      const st = getState(s);
      const rest = st.providers.providers.filter((p) => p.kind !== b.kind);
      const prior = st.providers.providers.find((p) => p.kind === b.kind);
      const next = {
        kind: b.kind,
        baseUrl: b.baseUrl ?? prior?.baseUrl ?? null,
        hasKey: Boolean(b.apiKey) || prior?.hasKey === true,
        isDefault: b.makeDefault === true || prior?.isDefault === true,
      };
      const providers = [...rest, next].map((p) =>
        b.makeDefault ? { ...p, isDefault: p.kind === b.kind } : p,
      );
      st.providers = { ...st.providers, providers };
      return st.providers;
    },

    'ai.removeProvider': (i, s): AiProvidersView => {
      const { kind } = i as { kind: AiProviderKind };
      const st = getState(s);
      st.providers = {
        ...st.providers,
        providers: st.providers.providers.filter((p) => p.kind !== kind),
      };
      return st.providers;
    },

    'ai.testProvider': (i, _s): AiTestResult => {
      const { kind } = i as { kind: AiProviderKind };
      return {
        ok: true,
        latencyMs: 480 + Math.round(Math.random() * 300),
        target: kind === 'anthropic' ? 'claude-haiku-4-5' : kind === 'openai' ? 'gpt-4o-mini' : 'https://llm.internal/v1/models',
        message: null,
      };
    },

    'ai.keys': (_i, s): AiKeyView[] => getState(s).keys,

    'ai.mintKey': (i, s): AiKeyMintResult => {
      const b = i as { name: string; appRef?: string; rpm?: number; dailyBudgetUsd?: number };
      const st = getState(s);
      const id = `demo-key-${Date.now()}`;
      st.keys = [
        {
          id,
          name: b.name,
          appRef: b.appRef ?? null,
          disabled: false,
          createdAt: nowIso(),
          limits: { rpm: b.rpm ?? null, dailyBudgetUsd: b.dailyBudgetUsd ?? null },
          usage30d: { requests: 0, costUsd: 0 },
        },
        ...st.keys,
      ];
      return { id, name: b.name, key: 'swk-ai-demoJp4Xq9tR2vWm7bYcAeK1sZ8gHnL0dQfU', gatewayUrl: GATEWAY_URL };
    },

    'ai.revokeKey': (i, s): { id: string; disabled: true } => {
      const { id } = i as { id: string };
      const st = getState(s);
      st.keys = st.keys.map((k) => (k.id === id ? { ...k, disabled: true } : k));
      return { id, disabled: true };
    },

    'ai.usage': (i, s): AiUsageSummaryView => {
      const { days = 14 } = (i ?? {}) as { days?: number };
      const st = getState(s);
      const window = st.usageDays.slice(-days);
      const totals = window.reduce(
        (acc, d) => ({
          requests: acc.requests + d.requests,
          inTokens: acc.inTokens + d.inTokens,
          outTokens: acc.outTokens + d.outTokens,
          costUsd: acc.costUsd + d.costUsd,
        }),
        { requests: 0, inTokens: 0, outTokens: 0, costUsd: 0 },
      );
      return {
        days: window,
        byModel: st.byModel,
        byKey: st.byKey,
        totals: {
          ...totals,
          cacheHits: Math.round(totals.requests * 0.11),
          avgLatencyMs: 920,
        },
        costIsEstimate: true,
      };
    },

    'ai.logs': (i, s): AiRequestLogView[] => {
      const { limit = 100 } = (i ?? {}) as { limit?: number };
      return getState(s).logs.slice(0, limit);
    },

    'ai.settings': (_i, s): AiSettingsView => getState(s).settings,

    'ai.setSettings': (i, s): AiSettingsView => {
      const b = i as { auditLog?: boolean; cache?: boolean };
      const st = getState(s);
      st.settings = {
        auditLog: b.auditLog ?? st.settings.auditLog,
        cache: b.cache ?? st.settings.cache,
      };
      return st.settings;
    },

    'ai.attachToService': (i, s) => {
      const b = i as { stack: string; appService: string };
      const st = getState(s);
      const keyName = `svc:${b.stack}/${b.appService}`;
      st.keys = [
        {
          id: `demo-key-${Date.now()}`,
          name: keyName,
          appRef: `${b.stack}/${b.appService}`,
          disabled: false,
          createdAt: nowIso(),
          limits: { rpm: null, dailyBudgetUsd: null },
          usage30d: { requests: 0, costUsd: 0 },
        },
        ...st.keys,
      ];
      return attachResult(b.stack, b.appService);
    },

    'ai.stackAccess': (i, s) => {
      const { stack } = i as { stack: string };
      const st = getState(s);
      const keyRow = st.keys.find((k) => k.name === stackKeyName(stack) && !k.disabled) ?? null;
      const attachedServices = st.keys
        .filter((k) => !k.disabled && k.appRef?.startsWith(`${stack}/`))
        .map((k) => ({ service: k.appRef!.slice(stack.length + 1), keyName: k.name }))
        .sort((a, b) => a.service.localeCompare(b.service));
      return {
        stack,
        key: keyRow
          ? { id: keyRow.id, name: keyRow.name, createdAt: keyRow.createdAt, limits: { ...keyRow.limits } }
          : null,
        attachedServices,
        outletDomain: st.outlets[stack] ?? null,
        gatewayUrl: GATEWAY_URL,
      };
    },

    'ai.grantStackAccess': (i, s) => {
      const b = i as { stack: string; services?: string[] };
      const st = getState(s);
      // Rotate: retire any prior stack key (mirrors the real grant flow).
      st.keys = st.keys.map((k) =>
        k.name === stackKeyName(b.stack) && !k.disabled
          ? { ...k, disabled: true, name: `${k.name} (rotated)` }
          : k,
      );
      const id = `demo-key-stack-${Date.now()}`;
      st.keys = [
        {
          id,
          name: stackKeyName(b.stack),
          appRef: b.stack,
          disabled: false,
          createdAt: nowIso(),
          limits: { rpm: null, dailyBudgetUsd: null },
          usage30d: { requests: 0, costUsd: 0 },
        },
        ...st.keys,
      ];
      const attached = (b.services ?? []).map((svc) => {
        st.keys = [
          {
            id: `demo-key-${svc}-${Date.now()}`,
            name: `svc:${b.stack}/${svc}`,
            appRef: `${b.stack}/${svc}`,
            disabled: false,
            createdAt: nowIso(),
            limits: { rpm: null, dailyBudgetUsd: null },
            usage30d: { requests: 0, costUsd: 0 },
          },
          ...st.keys,
        ];
        return attachResult(b.stack, svc);
      });
      return {
        stack: b.stack,
        keyId: id,
        keyName: stackKeyName(b.stack),
        key: 'swk-ai-demoStackXq9tR2vWm7bYcAeK1sZ8gHnL0dQfU',
        gatewayUrl: GATEWAY_URL,
        attached,
      };
    },

    'ai.revokeStackAccess': (i, s) => {
      const { stack } = i as { stack: string };
      const st = getState(s);
      let revoked = 0;
      st.keys = st.keys.map((k) => {
        const mine =
          k.name === stackKeyName(stack) || k.appRef === stack || Boolean(k.appRef?.startsWith(`${stack}/`));
        if (mine && !k.disabled) {
          revoked += 1;
          return { ...k, disabled: true };
        }
        return k;
      });
      return { stack, revoked };
    },

    'ai.setStackOutlet': (i, s) => {
      const b = i as { stack: string; domain: string };
      const st = getState(s);
      const domain = b.domain.trim().toLowerCase();
      if (domain) st.outlets[b.stack] = domain;
      else delete st.outlets[b.stack];
      return { stack: b.stack, domain: domain || null };
    },

    'ai.listOutlets': (_i, s) =>
      Object.entries(getState(s).outlets)
        .map(([stack, domain]) => ({ stack, domain }))
        .sort((a, b) => a.stack.localeCompare(b.stack)),
  },
};
