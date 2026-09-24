/**
 * JSON Schema (draft 2020-12) for swarmy.yaml v1 — editor autocomplete via
 * `# yaml-language-server: $schema=https://<controller>/schema/swarmy.v1.json`
 * (served by the controller in Phase 2; also publishable to SchemaStore).
 *
 * Hand-written rather than generated so descriptions read well in an editor
 * tooltip. `json-schema.test.ts` guards drift: every key the Zod schema
 * accepts must appear here and vice versa.
 */
import { CACHE_ENGINES, CACHE_TOPOLOGIES, SEARCH_ENGINES } from '@swarmy/core/views';
import {
  BUCKET_ACCESS,
  POSTGRES_HA,
  POSTGRES_VERSIONS,
  SIZE_PRESETS,
  VECTOR_ENGINES,
} from './schema';

const name = { type: 'string', pattern: '^[a-z][a-z0-9-]{0,29}$' } as const;
const duration = {
  anyOf: [
    { type: 'string', pattern: '^\\d+(s|m|h|d)$' },
    { type: 'integer', minimum: 0 },
  ],
  description: 'Duration: 90s, 15m, 48h, 7d (or seconds)',
} as const;
const size = {
  anyOf: [
    { type: 'string', pattern: '^\\d+(\\.\\d+)?\\s*([kmgt]i?b?)$' },
    { type: 'number', exclusiveMinimum: 0 },
  ],
  description: 'Size: 256mb, 2gb (or megabytes)',
} as const;
const command = {
  anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }],
} as const;
const env = {
  type: 'object',
  description: 'Env vars. Bind a resource with ${{ <resource>.<field> }}, e.g. ${{ db.url }}',
  propertyNames: { pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
  additionalProperties: { type: ['string', 'number', 'boolean'] },
} as const;
const relPath = { type: 'string', description: 'Path relative to the repo root' } as const;
const cron = { type: 'string', description: 'Five-field cron, e.g. "0 2 * * *"' } as const;

const protect = {
  type: 'object',
  additionalProperties: false,
  description: 'Edge protections for this route',
  properties: {
    rate_limit: {
      type: 'string',
      description: 'e.g. 100/min',
      pattern: '^\\d+\\s*/\\s*(s|sec|second|m|min|minute|h|hour)$',
    },
    ip_allow: { type: 'array', items: { type: 'string' } },
    ip_deny: { type: 'array', items: { type: 'string' } },
    countries_allow: { type: 'array', items: { type: 'string', pattern: '^[A-Z]{2}$' } },
    countries_deny: { type: 'array', items: { type: 'string', pattern: '^[A-Z]{2}$' } },
    block_bots: { type: 'boolean' },
    body_max: { type: 'string', description: 'Max request body, e.g. 10mb' },
    waf: { type: 'boolean', description: 'Block scanner paths + suspicious queries' },
    cache: { ...duration, description: 'Cache responses at the edge for this long' },
  },
} as const;

const service = {
  type: 'object',
  additionalProperties: false,
  description: 'A long-running service. Set exactly one of build or image.',
  properties: {
    build: {
      anyOf: [
        relPath,
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: {
              ...relPath,
              description: 'Build context (monorepo subpath). Default: repo root',
            },
            dockerfile: { type: 'string', description: 'Relative to path. Default: Dockerfile' },
            target: { type: 'string', description: 'Multi-stage build target' },
            args: { type: 'object', additionalProperties: { type: 'string' } },
            watch: {
              type: 'array',
              items: relPath,
              description: 'Rebuild only when these paths change. Default: [path]',
            },
          },
        },
      ],
    },
    image: { type: 'string', description: 'A prebuilt image (pin a tag or digest)' },
    command: command,
    release: {
      ...command,
      description:
        'Run once in the new image before it goes live (e.g. migrations); failure aborts the deploy',
    },
    port: {
      type: 'integer',
      minimum: 1,
      maximum: 65535,
      description: 'The port the app listens on',
    },
    replicas: { type: 'integer', minimum: 0, maximum: 100, default: 1 },
    sleep_after: {
      ...duration,
      description: 'Scale to zero after this much idle time; the next request wakes it',
    },
    size: { enum: Object.keys(SIZE_PRESETS), description: 'CPU + memory preset' },
    cpu: { type: 'number', exclusiveMinimum: 0, maximum: 64 },
    memory: size,
    healthcheck: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'HTTP GET path on port' },
        command: command,
        interval: duration,
        timeout: duration,
        retries: { type: 'integer', minimum: 1, maximum: 20 },
        start_period: duration,
      },
    },
    env,
    secrets: {
      type: 'array',
      items: { type: 'string' },
      description: 'swarmy secrets, mounted at /run/secrets/<name>',
    },
    volumes: {
      type: 'object',
      description: 'Named persistent volumes: { data: /var/lib/app }',
      propertyNames: name,
      additionalProperties: { type: 'string', pattern: '^/' },
    },
    domains: {
      type: 'array',
      items: {
        anyOf: [
          { type: 'string', description: 'Hostname, e.g. app.example.com' },
          {
            type: 'object',
            additionalProperties: false,
            required: ['host'],
            properties: {
              host: { type: 'string' },
              path: { type: 'string', default: '/' },
              strip_path: { type: 'boolean' },
              protect,
            },
          },
        ],
      },
    },
    regions: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      description: 'Run only on nodes in these swarmy regions',
    },
    placement: {
      type: 'object',
      additionalProperties: false,
      properties: { labels: { type: 'object', additionalProperties: { type: 'string' } } },
    },
  },
} as const;

const backups = {
  anyOf: [
    { const: false },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        schedule: { anyOf: [{ enum: ['hourly', 'daily', 'weekly'] }, cron], default: 'daily' },
        keep: { type: 'integer', minimum: 1, maximum: 365, default: 7 },
      },
    },
  ],
} as const;

const resource = {
  anyOf: [
    {
      enum: ['postgres', 'cache', 'search', 'vector', 'bucket'],
      description: 'Shorthand with all defaults',
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type'],
      properties: {
        type: { const: 'postgres' },
        version: { enum: [...POSTGRES_VERSIONS], default: 16 },
        ha: { enum: [...POSTGRES_HA], default: 'single' },
        replicas: { type: 'integer', minimum: 0, maximum: 20 },
        regions: {
          type: 'object',
          additionalProperties: { type: 'integer', minimum: 0 },
          description: 'ha: geo read replicas per region',
        },
        database: { type: 'string' },
        backups,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type'],
      properties: {
        type: { const: 'cache' },
        engine: { enum: [...CACHE_ENGINES], default: 'valkey' },
        ha: { enum: [...CACHE_TOPOLOGIES], default: 'single' },
        replicas: { type: 'integer', minimum: 0, maximum: 10 },
        memory: size,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type'],
      properties: {
        type: { const: 'search' },
        engine: { enum: [...SEARCH_ENGINES], default: 'meilisearch' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type'],
      properties: {
        type: { const: 'vector' },
        engine: { enum: [...VECTOR_ENGINES] },
        on: { ...name, description: 'pgvector: the postgres resource to enable it on' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type'],
      properties: {
        type: { const: 'bucket' },
        access: { enum: [...BUCKET_ACCESS], default: 'internal' },
        quota: size,
      },
    },
  ],
} as const;

const job = {
  type: 'object',
  additionalProperties: false,
  required: ['schedule', 'run'],
  properties: {
    schedule: cron,
    service: { ...name, description: "Run in this service's image and env" },
    image: { type: 'string' },
    run: command,
    timeout: duration,
    retries: { type: 'integer', minimum: 0, maximum: 10 },
    env,
  },
} as const;

const serviceOverride = {
  type: 'object',
  additionalProperties: false,
  description:
    'What this environment changes about the service. domains REPLACE production domains.',
  properties: {
    replicas: service.properties.replicas,
    sleep_after: service.properties.sleep_after,
    size: service.properties.size,
    cpu: service.properties.cpu,
    memory: service.properties.memory,
    env,
    domains: service.properties.domains,
    regions: service.properties.regions,
    command: service.properties.command,
  },
} as const;

const resourceOverride = {
  type: 'object',
  additionalProperties: false,
  description: 'What this environment changes about the resource (never its type)',
  properties: {
    version: { enum: [...POSTGRES_VERSIONS] },
    ha: { type: 'string' },
    replicas: { type: 'integer', minimum: 0, maximum: 20 },
    memory: size,
    backups,
    access: { enum: [...BUCKET_ACCESS] },
    quota: size,
  },
} as const;

const environment = {
  type: 'object',
  additionalProperties: false,
  required: ['branch'],
  properties: {
    branch: { type: 'string', description: 'A push to this branch deploys this environment' },
    env: { ...env, description: 'Env overrides for every service here' },
    services: { type: 'object', propertyNames: name, additionalProperties: serviceOverride },
    resources: { type: 'object', propertyNames: name, additionalProperties: resourceOverride },
    jobs: { type: 'boolean', default: true, description: "Run the app's cron jobs here" },
    connect: {
      type: 'array',
      items: { type: 'string' },
      description: 'Apps this environment links to',
    },
  },
} as const;

export const SWARMY_YAML_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://swarmy.dev/schema/swarmy.v1.json',
  title: 'swarmy.yaml',
  type: 'object',
  additionalProperties: false,
  required: ['version', 'app', 'services'],
  properties: {
    version: { const: 1 },
    app: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,39}$', description: 'The app (stack) name' },
    env: { ...env, description: 'Env shared by every service' },
    services: {
      type: 'object',
      propertyNames: name,
      additionalProperties: service,
      minProperties: 1,
    },
    resources: { type: 'object', propertyNames: name, additionalProperties: resource },
    jobs: { type: 'object', propertyNames: name, additionalProperties: job },
    previews: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean', default: false },
        ttl: { ...duration, default: '72h' },
        base_domain: { type: 'string' },
        resources: { enum: ['isolated', 'shared'], default: 'isolated' },
      },
    },
    connect: {
      type: 'array',
      items: { type: 'string' },
      description: 'Other apps this app may reach privately',
    },
    environments: {
      type: 'object',
      description:
        'Named environments (e.g. staging): each is its own stack <app>-<name> tracking a branch',
      propertyNames: {
        pattern: '^[a-z][a-z0-9-]{0,19}$',
        not: { enum: ['production', 'prod', 'preview'] },
      },
      additionalProperties: environment,
    },
  },
} as const;
