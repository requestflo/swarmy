import type { DemoStore, DomainResolvers } from '../types';

/**
 * `apps.configFile` in demo mode: storefront's swarmy.yaml at the commit its
 * production plan applied (the apps module's seed), with the last push and
 * poll read from the same plans. It parses clean with the real
 * @swarmy/app-config parser (source-demo.test.ts keeps it that way) and
 * describes the demo stack: web, api, checkout and worker over Postgres,
 * Valkey, Meilisearch and a bucket, with the Jobs tab's three schedules, and
 * the staging environment `apps.list` names (one copy each, debug logs).
 */
export const STOREFRONT_YAML = `# yaml-language-server: $schema=https://swarmy.dev/schema/swarmy.v1.json
version: 1
app: storefront
env:
  NODE_ENV: production
  LOG_LEVEL: info
  SHOP_CURRENCY: GBP

services:
  web:
    build: { path: web }
    port: 3000
    replicas: 3
    healthcheck: { path: /healthz, interval: 10s }
    domains: [shop.northwind.dev]
    env:
      API_URL: \${{ services.api.url }}
      PUBLIC_URL: \${{ app.url }}

  api:
    build: { path: api }
    port: 8080
    replicas: 4
    release: npm run migrate
    healthcheck: { path: /healthz }
    domains:
      - host: api.northwind.dev
        protect: { rate_limit: 600/min, block_bots: true }
    env:
      DATABASE_URL: \${{ db.url }}
      DATABASE_RO_URL: \${{ db.ro_url }}
      REDIS_URL: \${{ cache.url }}
      SEARCH_URL: \${{ search.url }}
      S3_ENDPOINT: \${{ storefront-media.endpoint }}
      S3_BUCKET: \${{ storefront-media.bucket }}
    secrets: [stripe-key]

  checkout:
    build: { path: checkout }
    port: 4000
    replicas: 2
    env:
      DATABASE_URL: \${{ db.url }}
      CHECKOUT_TIMEOUT_MS: 8000

  worker:
    build: { path: worker }
    command: [node, dist/worker.js]
    replicas: 3
    env:
      DATABASE_URL: \${{ db.url }}
      REDIS_URL: \${{ cache.url }}

resources:
  db:
    type: postgres
    version: 16
    ha: primary-replica
    backups: { schedule: daily, keep: 14 }
  cache: { type: cache, engine: valkey, memory: 512mb }
  search: { type: search, engine: meilisearch }
  storefront-media: { type: bucket, access: internal }

jobs:
  cache-warmup:
    schedule: "0 * * * *"
    service: api
    run: node scripts/warm-cache.js --top 500
    timeout: 5m
  sitemap:
    schedule: "30 3 * * *"
    service: web
    run: npm run sitemap
    retries: 1
  reindex-search:
    schedule: "0 4 * * *"
    service: api
    run: npm run reindex -- --index products
    retries: 2

previews: { enabled: true, ttl: 48h, base_domain: preview.northwind.dev }

environments:
  staging:
    branch: staging
    env: { LOG_LEVEL: debug }
    services:
      web: { replicas: 1, domains: [staging.shop.northwind.dev] }
      api: { replicas: 1 }
      checkout: { replicas: 1 }
      worker: { replicas: 1 }
`;

interface PlanLike {
  repoId: string;
  environment: string;
  stack: string;
  sha: string;
  trigger: string;
  createdAt: string;
}

const plansOf = (s: DemoStore): PlanLike[] =>
  [...((s.extra['apps'] as { plans?: PlanLike[] } | undefined)?.plans ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

export const appsConfigFile: DomainResolvers = {
  handlers: {
    'apps.configFile': (i, s) => {
      const { stack } = i as { stack: string };
      const plans = plansOf(s);
      const plan = plans.find((p) => p.stack === stack);
      if (!plan || stack !== 'storefront') return null;
      const latest = (triggers: string[]): string | null =>
        plans.find((p) => p.repoId === plan.repoId && triggers.includes(p.trigger))?.createdAt ?? null;
      return {
        repoId: plan.repoId,
        environment: plan.environment,
        path: 'swarmy.yaml',
        sha: plan.sha,
        text: STOREFRONT_YAML,
        fetchedAt: plan.createdAt,
        lastWebhookAt: latest(['push', 'pr']),
        lastPollAt: latest(['poll']),
        previewDomain: null,
      };
    },
  },
};
