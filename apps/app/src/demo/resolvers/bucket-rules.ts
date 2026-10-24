import { CORS_ALLOWED_HEADERS, CORS_EXPOSE_HEADERS, checkCorsOrigin, foldCorsRules, type CorsRuleView } from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * A bucket's own rules in demo mode — `buckets.getCors` / `setCors`. Mirrors
 * `bucket-cors.service.ts`: one stored rule per origin, folded back into one
 * policy, on a v2 engine (wildcard origins allowed). Keyed by bucket name.
 */

interface RulesState {
  cors: Record<string, CorsRuleView[]>;
}

const corsRule = (origin: string, methods: string[], maxAgeSeconds: number | null): CorsRuleView => ({
  origins: [origin],
  methods,
  allowedHeaders: [...CORS_ALLOWED_HEADERS],
  exposeHeaders: [...CORS_EXPOSE_HEADERS],
  maxAgeSeconds,
});

function state(store: DemoStore): RulesState {
  store.extra.bucketRules ??= {
    cors: {
      'storefront-media': ['https://shop.northwind.dev', 'https://*.northwind.dev', 'http://localhost:3000'].map((o) =>
        corsRule(o, ['GET', 'HEAD', 'PUT'], 3600),
      ),
    },
  } satisfies RulesState;
  return store.extra.bucketRules as RulesState;
}

function bucketName(store: DemoStore, bucketId: string): string {
  const all = (store.extra.buckets as { buckets?: Array<{ id: string; name: string }> } | undefined)?.buckets ?? [];
  const b = all.find((x) => x.id === bucketId);
  if (!b) throw new Error(`bucket "${bucketId}" not found`);
  return b.name;
}

function corsView(bucketId: string, bucket: string, rules: CorsRuleView[]) {
  return { bucketId, bucket, ...foldCorsRules(rules), wildcards: true, rules };
}

export const bucketRules: DomainResolvers = {
  handlers: {
    'buckets.getCors': (i, s) => {
      const { bucketId } = i as { bucketId: string };
      const name = bucketName(s, bucketId);
      return corsView(bucketId, name, state(s).cors[name] ?? []);
    },

    'buckets.setCors': (i, s) => {
      const input = i as { bucketId: string; origins: string[]; methods?: string[]; maxAgeSeconds?: number | null };
      const name = bucketName(s, input.bucketId);
      const origins: string[] = [];
      for (const raw of input.origins) {
        const check = checkCorsOrigin(raw, { wildcards: true });
        if (!check.ok) throw new Error(check.reason);
        if (!origins.includes(check.origin)) origins.push(check.origin);
      }
      const methods = input.methods ?? ['GET', 'HEAD'];
      if (origins.length && methods.length === 0) throw new Error('pick at least one method browsers may use');
      const maxAge = input.maxAgeSeconds === undefined ? 3600 : input.maxAgeSeconds;
      const rules = origins.map((o) => corsRule(o, methods, maxAge));
      state(s).cors[name] = rules;
      return corsView(input.bucketId, name, rules);
    },
  },
};
