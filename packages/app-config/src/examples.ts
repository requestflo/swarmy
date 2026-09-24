/**
 * Canonical swarmy.yaml examples — the starter the dashboard offers when a repo
 * has no swarmy.yaml, the spec's examples, and the golden inputs the tests
 * parse. If one of these stops parsing clean, the docs are lying.
 */

export const MINIMAL_EXAMPLE = `version: 1
app: blog
services:
  web:
    build: .
    port: 3000
    domains: [blog.example.com]
    env:
      DATABASE_URL: \${{ db.url }}
resources:
  db: postgres
`;

export const FULL_EXAMPLE = `# yaml-language-server: $schema=https://swarmy.dev/schema/swarmy.v1.json
version: 1
app: orders

env:
  NODE_ENV: production

services:
  web:
    build:
      path: services/orders
      dockerfile: Dockerfile
      args: { APP_VERSION: "2" }
      watch: [services/orders, packages/shared]
    port: 3000
    replicas: 2
    size: small
    healthcheck: { path: /healthz, interval: 10s }
    env:
      DATABASE_URL: \${{ db.url }}
      DATABASE_RO_URL: \${{ db.ro_url }}
      REDIS_URL: \${{ cache.url }}
      S3_ENDPOINT: \${{ invoices.endpoint }}
      S3_BUCKET: \${{ invoices.bucket }}
      SEARCH_URL: \${{ search.url }}
      PUBLIC_URL: \${{ app.url }}
    secrets: [stripe-key]
    domains:
      - orders.northwind.dev
      - host: api.northwind.dev
        path: /v1
        protect:
          rate_limit: 100/min
          countries_deny: [RU]
          block_bots: true
    regions: [eu-west]

  worker:
    build:
      path: services/orders
      dockerfile: Dockerfile
      args: { APP_VERSION: "2" }
      watch: [services/orders, packages/shared]
    command: [node, dist/worker.js]
    env:
      DATABASE_URL: \${{ db.url }}
      REDIS_URL: \${{ cache.url }}

  admin:
    image: ghcr.io/northwind/admin:1.4.2
    port: 8080
    sleep_after: 15m
    env:
      ORDERS_API: \${{ services.web.url }}
    domains: [admin.northwind.dev]
    volumes:
      uploads: /data/uploads

resources:
  db:
    type: postgres
    version: 16
    ha: primary-replica
    replicas: 1
    backups: { schedule: daily, keep: 14 }
  cache: { type: cache, engine: valkey, memory: 512mb }
  search: { type: search, engine: meilisearch }
  embeddings: { type: vector, engine: pgvector, on: db }
  invoices: { type: bucket, access: internal }

jobs:
  invoices:
    schedule: "0 2 * * *"
    service: worker
    run: npm run invoices
    timeout: 30m

previews:
  enabled: true
  ttl: 48h

connect: [billing]
`;
