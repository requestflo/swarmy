/**
 * swarmy.yaml v1 — the structural schema (Zod). This is the AUTHORED shape
 * (snake_case, shorthands allowed); `desired.ts` normalises it into the
 * fully-defaulted `DesiredApp` the planner diffs. Cross-field rules (refs
 * resolve, bindings are valid for the resource type, names don't collide)
 * live in `validate.ts`, not here — this file only answers "is each value
 * well-formed on its own".
 *
 * Keep `json-schema.ts` in step with this file: a drift test asserts both
 * describe the same keys.
 */
import { z } from 'zod';
import { CACHE_ENGINES, CACHE_TOPOLOGIES, SEARCH_ENGINES } from '@swarmy/core/views';
import { isCron, parseDuration, parseRate, parseSizeMb } from './units';
import { AuthSchema } from './auth';

/**
 * Managed-Postgres HA topologies. Mirrors `DB_TOPOLOGIES` in
 * packages/trpc/src/services/manageddb.service.ts (this package cannot depend
 * on @swarmy/trpc); Phase 2 adds a parity test on the trpc side.
 */
export const POSTGRES_HA = [
  'single',
  'primary-replica',
  'failover',
  'geo',
  'active-active',
] as const;
export type PostgresHa = (typeof POSTGRES_HA)[number];

export const POSTGRES_VERSIONS = [14, 15, 16, 17] as const;
export const DEFAULT_POSTGRES_VERSION = 16;

export const BUCKET_ACCESS = ['internal', 'mesh', 'public'] as const;
export type BucketAccess = (typeof BUCKET_ACCESS)[number];

export const VECTOR_ENGINES = ['qdrant', 'pgvector'] as const;

/** Service size presets → CPU cores + memory limit. */
export const SIZE_PRESETS = {
  nano: { cpu: 0.25, memoryMb: 256 },
  small: { cpu: 0.5, memoryMb: 512 },
  medium: { cpu: 1, memoryMb: 1024 },
  large: { cpu: 2, memoryMb: 2048 },
  xlarge: { cpu: 4, memoryMb: 4096 },
} as const;
export type SizePreset = keyof typeof SIZE_PRESETS;

/** A unit name: service, resource, job, volume. Becomes part of a swarm service name. */
export const UNIT_NAME_RE = /^[a-z][a-z0-9-]{0,29}$/;
const unitName = z
  .string()
  .regex(UNIT_NAME_RE, 'lowercase letters, digits and - only; starts with a letter; max 30');

const duration = z
  .union([z.string(), z.number()])
  .refine((v) => parseDuration(v) !== null, 'a duration like 90s, 15m, 48h or 7d');
const size = z
  .union([z.string(), z.number()])
  .refine((v) => parseSizeMb(v) !== null, 'a size like 256mb or 2gb');
const cron = z.string().refine(isCron, 'a five-field cron expression, e.g. "0 2 * * *"');
const relPath = z
  .string()
  .min(1)
  .refine(
    (p) => !p.startsWith('/') && !p.split('/').includes('..'),
    'a path relative to the repo root (no leading / or ..)',
  );
const commandLine = z.union([z.string().min(1), z.array(z.string()).nonempty()]);
const envValue = z.union([z.string(), z.number(), z.boolean()]);
const envMap = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'an env var name'), envValue);
const hostname = z
  .string()
  .regex(
    /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i,
    'a hostname like app.example.com',
  );
const countries = z.array(z.string().regex(/^[A-Z]{2}$/, 'ISO country code, e.g. GB'));

// ── services ─────────────────────────────────────────────────────────────────

export const BuildSchema = z.union([
  relPath,
  z
    .object({
      /** Build context, relative to the repo root (monorepo subpath). */
      path: relPath.default('.'),
      /** Dockerfile relative to `path`. */
      dockerfile: z.string().min(1).optional(),
      target: z.string().min(1).optional(),
      args: z.record(z.string()).optional(),
      /** Paths whose change triggers a rebuild (default: `path`). */
      watch: z.array(relPath).optional(),
    })
    .strict(),
]);

export const HealthcheckSchema = z
  .object({
    /** HTTP GET path against `port` (needs `port`). */
    path: z.string().startsWith('/').optional(),
    /** Or a command run in the container. */
    command: commandLine.optional(),
    interval: duration.optional(),
    timeout: duration.optional(),
    retries: z.number().int().min(1).max(20).optional(),
    start_period: duration.optional(),
  })
  .strict()
  .refine(
    (h) => (h.path === undefined) !== (h.command === undefined),
    'set exactly one of path or command',
  );

export const ProtectSchema = z
  .object({
    rate_limit: z.string().refine((v) => parseRate(v) !== null, 'a rate like 100/min'),
    ip_allow: z.array(z.string()),
    ip_deny: z.array(z.string()),
    countries_allow: countries,
    countries_deny: countries,
    block_bots: z.boolean(),
    body_max: z.string().regex(/^\d+(k|m|g)?b?$/i, 'a size like 10mb'),
    waf: z.boolean(),
    cache: duration,
  })
  .partial()
  .strict();

export const DomainSchema = z.union([
  hostname,
  z
    .object({
      host: hostname,
      path: z.string().startsWith('/').default('/'),
      strip_path: z.boolean().optional(),
      protect: ProtectSchema.optional(),
    })
    .strict(),
]);

export const ServiceSchema = z
  .object({
    build: BuildSchema.optional(),
    image: z.string().min(1).optional(),
    command: commandLine.optional(),
    /** Pre-deploy one-shot in the NEW image (migrations); a non-zero exit aborts the release. */
    release: commandLine.optional(),
    port: z.number().int().min(1).max(65535).optional(),
    replicas: z.number().int().min(0).max(100).optional(),
    /** Scale to zero after this much idle time; woken by the next request. */
    sleep_after: duration.optional(),
    size: z.enum(Object.keys(SIZE_PRESETS) as [SizePreset, ...SizePreset[]]).optional(),
    cpu: z.number().positive().max(64).optional(),
    memory: size.optional(),
    healthcheck: HealthcheckSchema.optional(),
    env: envMap.optional(),
    /** swarmy secret names; mounted read-only at /run/secrets/<name>. */
    secrets: z
      .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,55}$/, 'a secret name'))
      .optional(),
    /** Named persistent volumes: `{ data: /var/lib/app }`. */
    volumes: z.record(unitName, z.string().startsWith('/', 'an absolute mount path')).optional(),
    domains: z.array(DomainSchema).optional(),
    /** Pin to nodes whose swarmy.region is one of these. */
    regions: z.array(z.string().min(1)).nonempty().optional(),
    /** Extra node-label constraints: `{ gpu: "true" }`. */
    placement: z
      .object({ labels: z.record(z.string()) })
      .strict()
      .optional(),
  })
  .strict()
  .refine((s) => (s.build === undefined) !== (s.image === undefined), {
    message: 'set exactly one of build or image',
  });
export type ServiceInput = z.input<typeof ServiceSchema>;

// ── resources ────────────────────────────────────────────────────────────────

const backups = z.union([
  z.literal(false),
  z
    .object({
      schedule: z.union([z.enum(['hourly', 'daily', 'weekly']), cron]).default('daily'),
      keep: z.number().int().min(1).max(365).default(7),
    })
    .strict(),
]);

export const PostgresSchema = z
  .object({
    type: z.literal('postgres'),
    version: z
      .number()
      .int()
      .refine(
        (v) => (POSTGRES_VERSIONS as readonly number[]).includes(v),
        `one of ${POSTGRES_VERSIONS.join(', ')}`,
      )
      .optional(),
    ha: z.enum(POSTGRES_HA).optional(),
    replicas: z.number().int().min(0).max(20).optional(),
    /** Per-region read replicas for `ha: geo` — `{ eu-west: 1, us-east: 1 }`. */
    regions: z.record(z.number().int().min(0).max(20)).optional(),
    database: z
      .string()
      .regex(/^[A-Za-z0-9_]{1,63}$/)
      .optional(),
    backups: backups.optional(),
  })
  .strict();

export const CacheSchema = z
  .object({
    type: z.literal('cache'),
    engine: z.enum(CACHE_ENGINES).optional(),
    ha: z.enum(CACHE_TOPOLOGIES).optional(),
    replicas: z.number().int().min(0).max(10).optional(),
    memory: size.optional(),
  })
  .strict();

/**
 * A managed BullMQ queue: a BullMQ-ready Valkey (maxmemory-policy noeviction,
 * AOF on, in the default-on backups). Bind it like a cache —
 * `QUEUE_URL: ${{ jobs.url }}` — and point BullMQ's connection at it.
 */
export const QueueSchema = z
  .object({
    type: z.literal('queue'),
    engine: z.enum(CACHE_ENGINES).optional(),
    ha: z.enum(CACHE_TOPOLOGIES).optional(),
    replicas: z.number().int().min(0).max(10).optional(),
    memory: size.optional(),
  })
  .strict();

export const SearchSchema = z
  .object({ type: z.literal('search'), engine: z.enum(SEARCH_ENGINES).optional() })
  .strict();

export const VectorSchema = z
  .object({
    type: z.literal('vector'),
    engine: z.enum(VECTOR_ENGINES).optional(),
    /** pgvector: the postgres resource to enable the extension on. */
    on: unitName.optional(),
  })
  .strict();

export const BucketSchema = z
  .object({
    type: z.literal('bucket'),
    access: z.enum(BUCKET_ACCESS).optional(),
    quota: size.optional(),
  })
  .strict();

export const RESOURCE_TYPES = ['postgres', 'cache', 'queue', 'search', 'vector', 'bucket'] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export const ResourceObjectSchema = z.discriminatedUnion('type', [
  PostgresSchema,
  CacheSchema,
  QueueSchema,
  SearchSchema,
  VectorSchema,
  BucketSchema,
]);

/** `db: postgres` shorthand, or the full object. */
export const ResourceSchema = z.union([z.enum(RESOURCE_TYPES), ResourceObjectSchema]);
export type ResourceInput = z.input<typeof ResourceSchema>;

// ── jobs, previews, top level ────────────────────────────────────────────────

export const JobSchema = z
  .object({
    schedule: cron,
    /** Run in this service's image + env (default: the only built service). */
    service: unitName.optional(),
    image: z.string().min(1).optional(),
    run: commandLine,
    timeout: duration.optional(),
    retries: z.number().int().min(0).max(10).optional(),
    env: envMap.optional(),
  })
  .strict()
  .refine(
    (j) => !(j.service !== undefined && j.image !== undefined),
    'set at most one of service or image',
  );

export const PreviewsSchema = z
  .object({
    enabled: z.boolean().default(false),
    ttl: duration.optional(),
    /** Preview hosts are pr-<N>.<base_domain>; default = the org's preview domain. */
    base_domain: hostname.optional(),
    /** isolated = each PR gets its own throwaway resources; shared = reuse prod's (read with care). */
    resources: z.enum(['isolated', 'shared']).optional(),
    /** Also preview every push to a matching branch (`feature/*`, `release/**`) — not only PRs. */
    branches: z.array(z.string().min(1).max(200)).optional(),
    /**
     * Previews with data: each preview's Postgres starts as a COPY of `from`'s
     * latest backup (production or a named environment), optionally scrubbed
     * by a SQL file in the repo. The copy is destroyed with the preview.
     */
    data: z
      .object({
        from: z.string().regex(/^[a-z][a-z0-9-]{0,19}$/, 'production or an environment name'),
        scrub: relPath.refine((p) => p.endsWith('.sql'), 'a .sql file in the repo').optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

// ── named environments (staging, …) ──────────────────────────────────────────

/** What an environment may change about a service. Domains REPLACE (prod hostnames never leak into staging). */
export const ServiceOverrideSchema = z
  .object({
    replicas: z.number().int().min(0).max(100),
    sleep_after: duration,
    size: z.enum(Object.keys(SIZE_PRESETS) as [SizePreset, ...SizePreset[]]),
    cpu: z.number().positive().max(64),
    memory: size,
    env: envMap,
    domains: z.array(DomainSchema),
    regions: z.array(z.string().min(1)).nonempty(),
    command: commandLine,
  })
  .partial()
  .strict();

/** What an environment may change about a resource (never its type). */
export const ResourceOverrideSchema = z
  .object({
    version: z
      .number()
      .int()
      .refine(
        (v) => (POSTGRES_VERSIONS as readonly number[]).includes(v),
        `one of ${POSTGRES_VERSIONS.join(', ')}`,
      ),
    ha: z.string().min(1),
    replicas: z.number().int().min(0).max(20),
    memory: size,
    backups,
    access: z.enum(BUCKET_ACCESS),
    quota: size,
  })
  .partial()
  .strict();

export const ENV_NAME_RE = /^[a-z][a-z0-9-]{0,19}$/;
export const RESERVED_ENV_NAMES = ['production', 'prod', 'preview'] as const;

export const EnvironmentSchema = z
  .object({
    /** The branch this environment tracks (a push there deploys it). */
    branch: z.string().min(1).max(200),
    /** Shared env overrides for every service in this environment. */
    env: envMap.optional(),
    services: z.record(unitName, ServiceOverrideSchema).optional(),
    resources: z.record(unitName, ResourceOverrideSchema).optional(),
    /** Run the app's cron jobs here too (default true). */
    jobs: z.boolean().optional(),
    /** Apps this environment links to (default: none — prod links don't carry over). */
    connect: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, 'an app name')).optional(),
  })
  .strict();
export type EnvironmentInput = z.input<typeof EnvironmentSchema>;

export const AppConfigSchema = z
  .object({
    version: z.literal(1, { errorMap: () => ({ message: 'version must be 1' }) }),
    app: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, 'lowercase letters, digits and - only; max 40'),
    /** Env shared by every service (a service's own env wins). */
    env: envMap.optional(),
    services: z
      .record(unitName, ServiceSchema)
      .refine((s) => Object.keys(s).length > 0, 'define at least one service'),
    resources: z.record(unitName, ResourceSchema).optional(),
    jobs: z.record(unitName, JobSchema).optional(),
    previews: PreviewsSchema.optional(),
    /** End-user sign-in: a per-app Better Auth service at /auth on the app's domains (auth.ts). */
    auth: AuthSchema.optional(),
    /** Other apps (stacks) in this org whose services this app may reach — one private overlay per pair. */
    connect: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, 'an app name')).optional(),
    /** Named environments beside production, each its own stack `<app>-<name>` tracking a branch. */
    environments: z
      .record(
        z.string().regex(ENV_NAME_RE, 'lowercase letters, digits and - only; max 20'),
        EnvironmentSchema,
      )
      .optional(),
  })
  .strict();

export type AppConfigInput = z.input<typeof AppConfigSchema>;
export type AppConfig = z.output<typeof AppConfigSchema>;
