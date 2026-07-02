import { stringify as stringifyYaml } from 'yaml';
import type {
  BlueprintId,
  BlueprintMetaView,
  BlueprintParamsInput,
  BlueprintPlanStepView,
  BlueprintSize,
  CacheEngine,
  CacheTopology,
} from '@swarmy/core';
import { encodeQueuesLabel, QUEUES_LABEL } from '../queues.service';
import { clusterNetworkName, primaryServiceName } from '../manageddb.service';

/**
 * Blueprint catalog (slice F3) — static, parameterized generators that turn
 * `{name, domain?, size, options}` into an ordered list of {@link PlanStep}s.
 *
 * Everything here is PURE (unit-tested in catalog.test.ts): a plan is data.
 * The executor in `blueprints.service.ts` maps each step kind onto an EXISTING
 * service — manageddb `provisionDb`, cache `provisionCache`, buckets
 * `createBucket`/`attachToService`, secretsMgr `createSecretFamily`/
 * `attachSecretToService`, stack `deployFromCompose` and the ingress route
 * label — so blueprints add no new machinery, only composition.
 *
 * Credentials NEVER appear in a plan (or in the compose source that gets
 * persisted as the stack's config): generators reference `__SWARMY_*__` tokens
 * and post-deploy "wire" actions instead. The executor resolves tokens from
 * provision results at deploy time and applies them straight onto Docker
 * objects (service env / secret refs) — the same tradeoff manageddb's
 * `injectConnection` documents, and nothing lands in Postgres.
 */

// ── Tokens (resolved by the deploy executor; never present in plans' output) ──

export const TOKEN_DB_URL = '__SWARMY_DB_URL__';
export const TOKEN_DB_HOST = '__SWARMY_DB_HOST__';
export const TOKEN_DB_PASSWORD = '__SWARMY_DB_PASSWORD__';
export const TOKEN_DB_NAME = '__SWARMY_DB_NAME__';
export const TOKEN_REDIS_URL = '__SWARMY_REDIS_URL__';

/** Deterministic token name for a generated secret value. */
export function secretToken(family: string): string {
  return `__SWARMY_SECRET_${family.toUpperCase().replace(/[^A-Z0-9]/g, '_')}__`;
}

/** Replace every known token occurrence; unknown text is left untouched. */
export function substituteTokens(text: string, tokens: Record<string, string>): string {
  let out = text;
  for (const [token, value] of Object.entries(tokens)) {
    out = out.split(token).join(value);
  }
  return out;
}

// ── Plan steps (the typed contract between catalog and executor) ──────────────

/** Post-deploy wiring applied to a live service (redeploys it in place). */
export type WireAction =
  /** manageddb `injectConnection`: DATABASE_URL(+RO) env + cluster network. */
  | { type: 'db'; service: string; cluster: string; envVar: string }
  /** cache `attachCacheToService`: REDIS_URL env + password secret + network. */
  | { type: 'cache'; service: string; cluster: string; envVar: string }
  /** secretsMgr `attachSecretToService`: mount at /run/secrets/<family> + env path. */
  | { type: 'secret'; service: string; family: string; envName: string }
  /** buckets `attachToService`: S3_* env + bucket-scoped key as a Docker secret. */
  | { type: 'bucket'; service: string; bucket: string }
  /** Merge env vars (values may contain tokens) onto the live service spec. */
  | { type: 'env'; service: string; env: Record<string, string> };

export type PlanStep =
  | {
      kind: 'db.provision';
      label: string;
      payload: { cluster: string; replicas: number; database: string };
    }
  | {
      kind: 'cache.provision';
      label: string;
      payload: {
        cluster: string;
        engine: CacheEngine;
        topology: CacheTopology;
        memoryMb: number;
        replicas: number;
      };
    }
  | { kind: 'bucket'; label: string; payload: { name: string } }
  | {
      kind: 'secret';
      label: string;
      payload: {
        family: string;
        /** When set, the generated value is exposed to later steps as this token. */
        token?: string;
        /** One-time reveal appended to the deploy result (tokens substituted). */
        revealNote?: string;
      };
    }
  | {
      kind: 'stack.deploy';
      label: string;
      payload: {
        composeSource: string;
        services: string[];
        /** Overlay networks the compose references (ensured before deploy). */
        ensureNetworks: string[];
        /** Labels stamped per service right after the deploy (e.g. queue defs). */
        postLabels: Record<string, Record<string, string>>;
        wires: WireAction[];
      };
    }
  | { kind: 'ingress.route'; label: string; payload: { service: string; host: string; port: number } };

// ── Size presets ──────────────────────────────────────────────────────────────

export interface BlueprintSizePreset {
  appReplicas: number;
  dbReplicas: number;
  cacheMemoryMb: number;
  cacheReplicas: number;
  maxWorkers: number;
}

export const SIZE_PRESETS: Record<BlueprintSize, BlueprintSizePreset> = {
  s: { appReplicas: 1, dbReplicas: 0, cacheMemoryMb: 128, cacheReplicas: 0, maxWorkers: 3 },
  m: { appReplicas: 2, dbReplicas: 1, cacheMemoryMb: 256, cacheReplicas: 1, maxWorkers: 5 },
  l: { appReplicas: 3, dbReplicas: 2, cacheMemoryMb: 1024, cacheReplicas: 2, maxWorkers: 10 },
};

// ── Param helpers ─────────────────────────────────────────────────────────────

type Params = BlueprintParamsInput;

function strOpt(p: Params, key: string, fallback: string): string {
  const v = p.options[key];
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

function boolOpt(p: Params, key: string, fallback: boolean): boolean {
  const v = p.options[key];
  return typeof v === 'boolean' ? v : fallback;
}

function portOpt(p: Params, key: string, fallback: number): number {
  const n = Number.parseInt(strOpt(p, key, String(fallback)), 10);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
}

// ── Compose builder (pure YAML; NEVER carries a credential) ───────────────────

interface ComposeServiceDef {
  image: string;
  environment?: Record<string, string>;
  networks?: string[];
  /** Declared for compose fidelity (see composeToSpecs volume note below). */
  volumes?: string[];
  replicas?: number;
}

/**
 * Build a docker-compose document `composeToSpecs` can consume. Volumes and
 * top-level networks are declared for compose fidelity, but note that
 * `composeToSpecs` currently ignores `volumes:` — persistent mounts need the
 * planned composeToSpecs extension (tracked by the platform buildout).
 */
export function buildCompose(services: Record<string, ComposeServiceDef>): string {
  const svcObj: Record<string, unknown> = {};
  const volumeNames = new Set<string>();
  const networkNames = new Set<string>();
  for (const [name, def] of Object.entries(services)) {
    const svc: Record<string, unknown> = { image: def.image };
    if (def.environment && Object.keys(def.environment).length > 0) {
      svc.environment = def.environment;
    }
    if (def.volumes && def.volumes.length > 0) {
      svc.volumes = def.volumes;
      for (const v of def.volumes) {
        const source = v.split(':')[0];
        if (source && !source.startsWith('/')) volumeNames.add(source);
      }
    }
    if (def.networks && def.networks.length > 0) {
      svc.networks = def.networks;
      for (const n of def.networks) networkNames.add(n);
    }
    svc.deploy = { replicas: def.replicas ?? 1 };
    svcObj[name] = svc;
  }
  const doc: Record<string, unknown> = { services: svcObj };
  if (volumeNames.size > 0) {
    doc.volumes = Object.fromEntries([...volumeNames].map((v) => [v, null]));
  }
  if (networkNames.size > 0) {
    doc.networks = Object.fromEntries(
      [...networkNames].map((n) => [n, { driver: 'overlay', attachable: true }]),
    );
  }
  return stringifyYaml(doc);
}

// ── Shared step builders ──────────────────────────────────────────────────────

const DB_CLUSTER = 'db';
const CACHE_CLUSTER = 'cache';
const DB_DATABASE = 'app';

function dbStep(preset: BlueprintSizePreset): PlanStep {
  return {
    kind: 'db.provision',
    label: 'Provision Postgres cluster',
    payload: { cluster: DB_CLUSTER, replicas: preset.dbReplicas, database: DB_DATABASE },
  };
}

function cacheStep(preset: BlueprintSizePreset): PlanStep {
  return {
    kind: 'cache.provision',
    label: 'Provision Valkey cache',
    payload: {
      cluster: CACHE_CLUSTER,
      engine: 'valkey',
      topology: preset.cacheReplicas > 0 ? 'replica' : 'single',
      memoryMb: preset.cacheMemoryMb,
      replicas: preset.cacheReplicas,
    },
  };
}

function secretStep(family: string, opts: { token?: string; revealNote?: string } = {}): PlanStep {
  return {
    kind: 'secret',
    label: `Generate secret ${family}`,
    payload: { family, ...opts },
  };
}

function bucketStep(name: string): PlanStep {
  return { kind: 'bucket', label: `Create bucket ${name}`, payload: { name } };
}

function deployStep(
  stack: string,
  services: Record<string, ComposeServiceDef>,
  opts: {
    ensureNetworks?: string[];
    postLabels?: Record<string, Record<string, string>>;
    wires?: WireAction[];
  } = {},
): PlanStep {
  const names = Object.keys(services);
  return {
    kind: 'stack.deploy',
    label: `Deploy stack ${stack} (${names.length} service${names.length === 1 ? '' : 's'})`,
    payload: {
      composeSource: buildCompose(services),
      services: names,
      ensureNetworks: opts.ensureNetworks ?? [],
      postLabels: opts.postLabels ?? {},
      wires: opts.wires ?? [],
    },
  };
}

function routeStep(service: string, host: string, port: number): PlanStep {
  return {
    kind: 'ingress.route',
    label: `Route https://${host} → ${service}:${port}`,
    payload: { service, host, port },
  };
}

// ── The catalog ───────────────────────────────────────────────────────────────

export interface BlueprintEntry {
  meta: BlueprintMetaView;
  plan: (params: Params) => PlanStep[];
}

const imageOption = (defaultValue: string, help: string) => ({
  key: 'image',
  label: 'Image',
  kind: 'string' as const,
  help,
  placeholder: defaultValue,
  defaultValue,
});

export const BLUEPRINT_CATALOG: BlueprintEntry[] = [
  {
    meta: {
      id: 'node-api',
      name: 'Node API',
      tagline: 'Your Node.js API with a managed Postgres wired in.',
      category: 'app',
      resources: ['Postgres', 'App', 'Route'],
      docOnly: false,
      supportsDomain: true,
      options: [
        imageOption('ghcr.io/acme/node-api:latest', 'Your built API image.'),
        { key: 'port', label: 'Port', kind: 'string', help: 'The port your API listens on.', placeholder: '3000', defaultValue: '3000' },
        { key: 'database', label: 'Managed Postgres', kind: 'boolean', help: 'Provision a Postgres cluster and inject DATABASE_URL.', defaultValue: true },
      ],
    },
    plan: (p) => {
      const preset = SIZE_PRESETS[p.size];
      const app = `${p.name}-api`;
      const port = portOpt(p, 'port', 3000);
      const withDb = boolOpt(p, 'database', true);
      const steps: PlanStep[] = [];
      if (withDb) steps.push(dbStep(preset));
      steps.push(
        deployStep(
          p.name,
          {
            [app]: {
              image: strOpt(p, 'image', 'ghcr.io/acme/node-api:latest'),
              environment: { NODE_ENV: 'production', PORT: String(port) },
              replicas: preset.appReplicas,
            },
          },
          {
            wires: withDb
              ? [{ type: 'db', service: app, cluster: DB_CLUSTER, envVar: 'DATABASE_URL' }]
              : [],
          },
        ),
      );
      if (p.domain) steps.push(routeStep(app, p.domain, port));
      return steps;
    },
  },
  {
    meta: {
      id: 'nextjs-app',
      name: 'Next.js app',
      tagline: 'A production Next.js deployment, optionally with an uploads bucket.',
      category: 'app',
      resources: ['App', 'Bucket', 'Route'],
      docOnly: false,
      supportsDomain: true,
      options: [
        imageOption('ghcr.io/acme/web:latest', 'Your built Next.js (standalone) image.'),
        { key: 'bucket', label: 'Uploads bucket', kind: 'boolean', help: 'Create an S3 bucket and inject S3_* credentials.', defaultValue: false },
      ],
    },
    plan: (p) => {
      const preset = SIZE_PRESETS[p.size];
      const app = `${p.name}-web`;
      const withBucket = boolOpt(p, 'bucket', false);
      const bucket = `${p.name}-uploads`;
      const steps: PlanStep[] = [];
      if (withBucket) steps.push(bucketStep(bucket));
      steps.push(
        deployStep(
          p.name,
          {
            [app]: {
              image: strOpt(p, 'image', 'ghcr.io/acme/web:latest'),
              environment: { NODE_ENV: 'production', PORT: '3000', HOSTNAME: '0.0.0.0' },
              replicas: preset.appReplicas,
            },
          },
          { wires: withBucket ? [{ type: 'bucket', service: app, bucket }] : [] },
        ),
      );
      if (p.domain) steps.push(routeStep(app, p.domain, 3000));
      return steps;
    },
  },
  {
    meta: {
      id: 'static-site',
      name: 'Static site',
      tagline: 'A static site or SPA behind swarmy ingress with automatic TLS.',
      category: 'app',
      resources: ['App', 'Route'],
      docOnly: false,
      supportsDomain: true,
      options: [imageOption('nginx:1.27-alpine', 'An image serving your site on port 80.')],
    },
    plan: (p) => {
      const preset = SIZE_PRESETS[p.size];
      const app = `${p.name}-site`;
      const steps: PlanStep[] = [
        deployStep(p.name, {
          [app]: { image: strOpt(p, 'image', 'nginx:1.27-alpine'), replicas: preset.appReplicas },
        }),
      ];
      if (p.domain) steps.push(routeStep(app, p.domain, 80));
      return steps;
    },
  },
  {
    meta: {
      id: 'wordpress',
      name: 'WordPress',
      tagline: 'WordPress + MariaDB with persistent volumes and a routed domain.',
      category: 'cms',
      resources: ['MariaDB', 'Volume', 'App', 'Route'],
      docOnly: false,
      supportsDomain: true,
      options: [],
    },
    plan: (p) => {
      const db = `${p.name}-db`;
      const wp = `${p.name}-wordpress`;
      const net = `${p.name}-net`;
      const family = `${p.name}-db-password`;
      const steps: PlanStep[] = [
        secretStep(family),
        deployStep(
          p.name,
          {
            [db]: {
              image: 'mariadb:11.4',
              environment: {
                MARIADB_DATABASE: 'wordpress',
                MARIADB_USER: 'wordpress',
                MARIADB_RANDOM_ROOT_PASSWORD: '1',
              },
              volumes: [`${p.name}-db-data:/var/lib/mysql`],
              networks: [net],
              replicas: 1,
            },
            [wp]: {
              image: 'wordpress:6.7-apache',
              environment: {
                WORDPRESS_DB_HOST: db,
                WORDPRESS_DB_USER: 'wordpress',
                WORDPRESS_DB_NAME: 'wordpress',
              },
              volumes: [`${p.name}-wp-content:/var/www/html/wp-content`],
              networks: [net],
              replicas: 1,
            },
          },
          {
            ensureNetworks: [net],
            // The official images read *_FILE secrets — the password never
            // touches env or the persisted compose.
            wires: [
              { type: 'secret', service: db, family, envName: 'MARIADB_PASSWORD_FILE' },
              { type: 'secret', service: wp, family, envName: 'WORDPRESS_DB_PASSWORD_FILE' },
            ],
          },
        ),
      ];
      if (p.domain) steps.push(routeStep(wp, p.domain, 80));
      return steps;
    },
  },
  {
    meta: {
      id: 'n8n',
      name: 'n8n',
      tagline: 'Workflow automation on managed Postgres with an encrypted key store.',
      category: 'automation',
      resources: ['Postgres', 'Secret', 'App', 'Route'],
      docOnly: false,
      supportsDomain: true,
      options: [],
    },
    plan: (p) => {
      const preset = SIZE_PRESETS[p.size];
      const app = `${p.name}-n8n`;
      const family = `${p.name}-encryption-key`;
      const steps: PlanStep[] = [
        dbStep(preset),
        secretStep(family),
        deployStep(
          p.name,
          {
            [app]: {
              image: 'n8nio/n8n:1.76.1',
              environment: {
                DB_TYPE: 'postgresdb',
                DB_POSTGRESDB_HOST: primaryServiceName(p.name, DB_CLUSTER),
                DB_POSTGRESDB_PORT: '5432',
                DB_POSTGRESDB_DATABASE: DB_DATABASE,
                DB_POSTGRESDB_USER: 'postgres',
                ...(p.domain
                  ? { N8N_HOST: p.domain, N8N_PROTOCOL: 'https', WEBHOOK_URL: `https://${p.domain}/` }
                  : {}),
              },
              volumes: [`${p.name}-n8n-data:/home/node/.n8n`],
              networks: [clusterNetworkName(p.name, DB_CLUSTER)],
              replicas: 1,
            },
          },
          {
            wires: [
              { type: 'secret', service: app, family, envName: 'N8N_ENCRYPTION_KEY_FILE' },
              { type: 'env', service: app, env: { DB_POSTGRESDB_PASSWORD: TOKEN_DB_PASSWORD } },
            ],
          },
        ),
      ];
      if (p.domain) steps.push(routeStep(app, p.domain, 5678));
      return steps;
    },
  },
  {
    meta: {
      id: 'directus',
      name: 'Directus',
      tagline: 'Instant headless CMS + admin app on a managed Postgres.',
      category: 'cms',
      resources: ['Postgres', 'Secret', 'App', 'Route'],
      docOnly: false,
      supportsDomain: true,
      options: [
        { key: 'adminEmail', label: 'Admin email', kind: 'string', help: 'First admin account.', placeholder: 'admin@example.com', defaultValue: 'admin@example.com' },
        { key: 's3Uploads', label: 'S3 uploads bucket', kind: 'boolean', help: 'Create a bucket and inject S3_* credentials for file storage.', defaultValue: false },
      ],
    },
    plan: (p) => {
      const preset = SIZE_PRESETS[p.size];
      const app = `${p.name}-directus`;
      const secretFamily = `${p.name}-secret`;
      const adminFamily = `${p.name}-admin-password`;
      const adminEmail = strOpt(p, 'adminEmail', 'admin@example.com');
      const s3 = boolOpt(p, 's3Uploads', false);
      const bucket = `${p.name}-uploads`;
      const steps: PlanStep[] = [
        dbStep(preset),
        secretStep(secretFamily),
        secretStep(adminFamily, {
          token: secretToken(adminFamily),
          revealNote: `Directus admin login — ${adminEmail} / ${secretToken(adminFamily)} (shown once, save it now)`,
        }),
      ];
      if (s3) steps.push(bucketStep(bucket));
      steps.push(
        deployStep(
          p.name,
          {
            [app]: {
              image: 'directus/directus:11.3',
              environment: {
                DB_CLIENT: 'pg',
                DB_HOST: primaryServiceName(p.name, DB_CLUSTER),
                DB_PORT: '5432',
                DB_DATABASE: DB_DATABASE,
                DB_USER: 'postgres',
                ADMIN_EMAIL: adminEmail,
                ...(p.domain ? { PUBLIC_URL: `https://${p.domain}` } : {}),
              },
              volumes: [`${p.name}-uploads-data:/directus/uploads`],
              networks: [clusterNetworkName(p.name, DB_CLUSTER)],
              replicas: 1,
            },
          },
          {
            wires: [
              { type: 'secret', service: app, family: secretFamily, envName: 'SECRET_FILE' },
              {
                type: 'env',
                service: app,
                env: {
                  DB_PASSWORD: TOKEN_DB_PASSWORD,
                  ADMIN_PASSWORD: secretToken(adminFamily),
                },
              },
              ...(s3 ? [{ type: 'bucket', service: app, bucket } as const] : []),
            ],
          },
        ),
      );
      if (p.domain) steps.push(routeStep(app, p.domain, 8055));
      return steps;
    },
  },
  {
    meta: {
      id: 'worker-with-queue',
      name: 'Worker + queue',
      tagline: 'A background worker on a managed cache, autoscaled by queue depth.',
      category: 'app',
      resources: ['Cache', 'Queue', 'Worker'],
      docOnly: false,
      supportsDomain: false,
      options: [
        imageOption('ghcr.io/acme/worker:latest', 'Your BullMQ (or compatible) worker image.'),
        { key: 'queue', label: 'Queue name', kind: 'string', help: 'The BullMQ queue the worker consumes.', placeholder: 'jobs', defaultValue: 'jobs' },
      ],
    },
    plan: (p) => {
      const preset = SIZE_PRESETS[p.size];
      const worker = `${p.name}-worker`;
      const queue = strOpt(p, 'queue', 'jobs');
      return [
        cacheStep(preset),
        deployStep(
          p.name,
          {
            [worker]: {
              image: strOpt(p, 'image', 'ghcr.io/acme/worker:latest'),
              environment: { QUEUE_NAME: queue },
              replicas: 1,
            },
          },
          {
            postLabels: {
              [worker]: {
                [QUEUES_LABEL]: encodeQueuesLabel([
                  {
                    name: queue,
                    cacheCluster: CACHE_CLUSTER,
                    convention: 'bullmq',
                    scalePerJobs: 25,
                    minWorkers: 1,
                    maxWorkers: preset.maxWorkers,
                    retries: 3,
                    dlq: true,
                  },
                ]),
              },
            },
            wires: [{ type: 'cache', service: worker, cluster: CACHE_CLUSTER, envVar: 'REDIS_URL' }],
          },
        ),
      ];
    },
  },
  {
    meta: {
      id: 'meilisearch-app',
      name: 'Meilisearch app',
      tagline: 'Lightning-fast search: Meilisearch plus your app, keys wired in.',
      category: 'data',
      resources: ['Search', 'Secret', 'App', 'Route'],
      docOnly: false,
      supportsDomain: true,
      options: [
        imageOption('ghcr.io/acme/search-app:latest', 'Your app image (reads MEILI_HOST + MEILI_API_KEY).'),
        { key: 'app', label: 'Deploy an app service', kind: 'boolean', help: 'Off = Meilisearch only.', defaultValue: true },
      ],
    },
    plan: (p) => {
      const preset = SIZE_PRESETS[p.size];
      const search = `${p.name}-search`;
      const app = `${p.name}-app`;
      const net = `${p.name}-net`;
      const family = `${p.name}-master-key`;
      const withApp = boolOpt(p, 'app', true);
      const services: Record<string, ComposeServiceDef> = {
        [search]: {
          image: 'getmeili/meilisearch:v1.12',
          environment: { MEILI_ENV: 'production' },
          volumes: [`${p.name}-search-data:/meili_data`],
          networks: [net],
          replicas: 1,
        },
      };
      if (withApp) {
        services[app] = {
          image: strOpt(p, 'image', 'ghcr.io/acme/search-app:latest'),
          environment: { MEILI_HOST: `http://${search}:7700`, PORT: '3000' },
          networks: [net],
          replicas: preset.appReplicas,
        };
      }
      const token = secretToken(family);
      const steps: PlanStep[] = [
        secretStep(family, { token }),
        deployStep(p.name, services, {
          ensureNetworks: [net],
          wires: [
            { type: 'env', service: search, env: { MEILI_MASTER_KEY: token } },
            ...(withApp
              ? [{ type: 'env', service: app, env: { MEILI_API_KEY: token } } as const]
              : []),
          ],
        }),
      ];
      if (p.domain) {
        steps.push(withApp ? routeStep(app, p.domain, 3000) : routeStep(search, p.domain, 7700));
      }
      return steps;
    },
  },
  {
    meta: {
      id: 'monitoring-notes',
      name: 'Monitoring',
      tagline: 'Nothing to deploy — observability is already built into swarmy.',
      category: 'docs',
      resources: ['Docs'],
      docOnly: true,
      supportsDomain: false,
      options: [],
    },
    plan: () => [],
  },
];

export function getBlueprint(id: BlueprintId): BlueprintEntry {
  const entry = BLUEPRINT_CATALOG.find((e) => e.meta.id === id);
  if (!entry) throw new Error(`unknown blueprint "${id}"`);
  return entry;
}

// ── Plan projection (display-safe) ────────────────────────────────────────────

/** Project one plan step into its display-safe view (never carries a token). */
export function planStepView(step: PlanStep): BlueprintPlanStepView {
  switch (step.kind) {
    case 'db.provision':
      return {
        kind: step.kind,
        label: step.label,
        detail: {
          cluster: step.payload.cluster,
          engine: 'postgres',
          replicas: `${step.payload.replicas} read replica${step.payload.replicas === 1 ? '' : 's'}`,
        },
      };
    case 'cache.provision':
      return {
        kind: step.kind,
        label: step.label,
        detail: {
          cluster: step.payload.cluster,
          engine: step.payload.engine,
          memory: `${step.payload.memoryMb} MB`,
          topology: step.payload.topology,
        },
      };
    case 'bucket':
      return { kind: step.kind, label: step.label, detail: { bucket: step.payload.name } };
    case 'secret':
      return {
        kind: step.kind,
        label: step.label,
        detail: { family: step.payload.family, value: 'generated · write-only' },
      };
    case 'stack.deploy':
      return {
        kind: step.kind,
        label: step.label,
        detail: { services: step.payload.services.join(', ') },
      };
    case 'ingress.route':
      return {
        kind: step.kind,
        label: step.label,
        detail: {
          host: step.payload.host,
          service: step.payload.service,
          port: String(step.payload.port),
        },
      };
  }
}

/** "Will create: Postgres cluster db, stack blog (2 services), route …". */
export function buildPlanSummary(stack: string, steps: PlanStep[]): string {
  if (steps.length === 0) return 'Nothing to deploy — this blueprint is documentation.';
  const parts = steps.map((s) => {
    switch (s.kind) {
      case 'db.provision':
        return `Postgres cluster ${stack}/${s.payload.cluster}`;
      case 'cache.provision':
        return `${s.payload.engine} cache ${stack}/${s.payload.cluster} (${s.payload.memoryMb} MB)`;
      case 'bucket':
        return `bucket ${s.payload.name}`;
      case 'secret':
        return `secret ${s.payload.family}`;
      case 'stack.deploy':
        return `stack ${stack} (${s.payload.services.length} service${s.payload.services.length === 1 ? '' : 's'})`;
      case 'ingress.route':
        return `route ${s.payload.host}`;
    }
  });
  return `Will create: ${parts.join(', ')}.`;
}
