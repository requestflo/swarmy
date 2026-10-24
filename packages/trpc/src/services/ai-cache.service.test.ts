import { afterEach, describe, expect, it } from 'bun:test';
import { registerAiCacheStats } from '@swarmy/core';
import type { OrgContext } from '../context';
import { cacheStats, setRouteCache } from './ai-cache.service';

/** In-memory OrgContext: one AiProviderConfig row, an audit sink, an empty swarm. */
function mockCtx(providersJson: unknown = { providers: [{ kind: 'openai', isDefault: true }] }) {
  const row = { providersJson, configEnc: null as string | null };
  const audit: Array<{ action: string; targetId: string | null; metadata: unknown }> = [];
  const ctx = {
    activeOrgId: 'o1',
    user: { id: 'u1' },
    db: {
      aiProviderConfig: {
        findUnique: async () => row,
        upsert: async (a: { update: { providersJson: unknown } }) => Object.assign(row, a.update),
      },
      auditLog: { create: async (a: { data: (typeof audit)[number] }) => audit.push(a.data) },
    },
    hub: { liveInventory: () => ({ services: [], containers: [] }) },
  } as unknown as OrgContext;
  return { ctx, row, audit };
}

afterEach(() => registerAiCacheStats(null));

describe('ai.setRouteCache — opt-in per route on the AI config document', () => {
  it('turns a default alias on and off, audited with the previous setting', async () => {
    const { ctx, row, audit } = mockCtx();
    const on = await setRouteCache(ctx, { route: 'smart', cache: { ttlSeconds: 600, similarity: 0.92 } });
    expect(on.routeCache).toEqual({ smart: { ttlSeconds: 600, similarity: 0.92 } });
    expect((row.providersJson as { routeCache: unknown }).routeCache).toEqual(on.routeCache);
    const off = await setRouteCache(ctx, { route: 'smart', cache: null });
    expect(off.routeCache).toEqual({});
    expect(audit.map((a) => [a.action, a.targetId, a.metadata])).toEqual([
      ['ai.routeCache.set', 'smart', { cache: { ttlSeconds: 600, similarity: 0.92 }, previous: null }],
      ['ai.routeCache.set', 'smart', { cache: null, previous: { ttlSeconds: 600, similarity: 0.92 } }],
    ]);
  });

  it('keeps the rest of the document (providers, routes) untouched', async () => {
    const { ctx, row } = mockCtx({ providers: [{ kind: 'openai', isDefault: true }], routes: { mine: { strategy: 'fallback', targets: [{ provider: 'openai', model: 'gpt-5' }] } } });
    await setRouteCache(ctx, { route: 'mine', cache: { ttlSeconds: 3600, similarity: null } });
    const doc = row.providersJson as { providers: unknown[]; routes: Record<string, unknown> };
    expect(doc.providers).toHaveLength(1);
    expect(Object.keys(doc.routes)).toEqual(['mine']);
  });
});

describe('ai.cacheStats — read through the in-process seam', () => {
  it('empty when no gateway runs in this process, or it throws', () => {
    const { ctx } = mockCtx();
    expect(cacheStats(ctx)).toEqual({ since: null, routes: [] });
    registerAiCacheStats(() => {
      throw new Error('boom');
    });
    expect(cacheStats(ctx)).toEqual({ since: null, routes: [] });
  });

  it("returns the gateway's counters for the caller's org only", () => {
    const { ctx } = mockCtx();
    registerAiCacheStats((orgId) => ({ since: '2026-10-24T00:00:00.000Z', routes: orgId === 'o1' ? [{ route: 'smart', lookups: 4, sameHits: 1, similarHits: 1, entries: 2, savedUsd: 0.01, embedErrors: 0 }] : [] }));
    expect(cacheStats(ctx).routes.map((r) => r.route)).toEqual(['smart']);
  });
});
