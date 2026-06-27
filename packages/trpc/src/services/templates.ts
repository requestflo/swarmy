import type { ServiceSpec } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { notFound } from '../errors';
import { deployFromCompose } from './stack.service';
import { upsertRecord } from './geodns.service';
import { writeAudit } from './audit.service';

/**
 * Ready-made HA service templates (epic #12, Part B — MVP).
 *
 * A template is a pure, parameterised bundle that renders:
 *  - N {@link ServiceSpec}s wired with `placement` constraints/preferences across
 *    regions (the `swarmy.region` node label) for anti-affinity + quorum spread.
 *  - a `composeSource` string, so the EXACT same stack runs with plain
 *    `docker stack deploy` and no swarmy (the unopinionated guarantee).
 *
 * Render is pure (no IO) so it powers a GUI preview the same way
 * `ingress.previewConfig` does. Built-ins live in code; the registry mirrors the
 * ingress driver registry so third-party templates could register later.
 *
 * MVP ships two: `postgres-ha` (streaming primary + replica) and `redis-ha`
 * (primary + replicas + sentinels). Both are region/anti-affinity aware.
 */

export type TemplateId = 'postgres-ha' | 'redis-ha';
export type TemplateKind = 'database' | 'cache';

export interface TemplateParams {
  /** Stack/service base name, e.g. "orders-db". */
  name: string;
  /** Regions to spread across (the `swarmy.region` label values). >=3 for clean quorum. */
  regions: string[];
  /** Image tag override (digest-pin in production). */
  image?: string;
  /** Per-region replica count for stateless-ish members. */
  replicasPerRegion?: number;
}

export interface RenderedTemplate {
  /** swarmy-native specs (placement-aware) for the deploy pipeline. */
  services: ServiceSpec[];
  /** Portable compose document (runs with `docker stack deploy`, no swarmy). */
  composeSource: string;
  /** One-line connection hint surfaced in the UI. */
  connectionHint: string;
  /** Honest durability note (RPO/RTO) — we never oversell zero-data-loss. */
  durabilityNote: string;
}

export interface TemplateMeta {
  id: TemplateId;
  kind: TemplateKind;
  engine: 'postgres' | 'redis';
  title: string;
  blurb: string;
  /** Minimum regions for clean automatic failover (quorum tiebreaker). */
  recommendedRegions: number;
}

export interface TemplateDefinition extends TemplateMeta {
  render(params: TemplateParams): RenderedTemplate;
}

// ───────────────────────────────────────────── helpers ──

/** `placement` block that pins a member to ONE region (quorum member). */
function pinnedToRegion(region: string): ServiceSpec['placement'] {
  return { constraints: [`node.labels.swarmy.region==${region}`] };
}

/** `placement` block that spreads replicas across regions + caps per node. */
function spreadAcrossRegions(): ServiceSpec['placement'] {
  return {
    preferences: ['spread=node.labels.swarmy.region'],
    maxReplicasPerNode: 1,
  };
}

function envBlock(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `        - ${k}=${v}`)
    .join('\n');
}

function composeService(opts: {
  name: string;
  image: string;
  env?: Record<string, string>;
  command?: string[];
  replicas?: number;
  constraints?: string[];
  preferences?: string[];
  maxReplicasPerNode?: number;
}): string {
  const lines: string[] = [`  ${opts.name}:`, `    image: ${opts.image}`];
  if (opts.command?.length) {
    lines.push(`    command: ${JSON.stringify(opts.command)}`);
  }
  if (opts.env && Object.keys(opts.env).length) {
    lines.push('    environment:');
    lines.push(envBlock(opts.env));
  }
  lines.push('    deploy:');
  if (opts.replicas !== undefined) lines.push(`      replicas: ${opts.replicas}`);
  lines.push('      placement:');
  if (opts.constraints?.length) {
    lines.push('        constraints:');
    for (const c of opts.constraints) lines.push(`          - ${c}`);
  }
  if (opts.preferences?.length) {
    lines.push('        preferences:');
    for (const p of opts.preferences) lines.push(`          - spread: ${p}`);
  }
  if (opts.maxReplicasPerNode !== undefined) {
    lines.push(`      max_replicas_per_node: ${opts.maxReplicasPerNode}`);
  }
  return lines.join('\n');
}

// ───────────────────────────────────────────── postgres-ha ──

const POSTGRES_IMAGE = 'bitnami/postgresql-repmgr:16';

function renderPostgresHa(p: TemplateParams): RenderedTemplate {
  const image = p.image ?? POSTGRES_IMAGE;
  const regions = p.regions.length ? p.regions : ['default'];
  const baseEnv: Record<string, string> = {
    POSTGRESQL_PASSWORD: '${POSTGRES_PASSWORD:-changeme}',
    REPMGR_PASSWORD: '${REPMGR_PASSWORD:-changeme}',
    POSTGRESQL_DATABASE: p.name.replace(/[^a-z0-9_]/gi, '_'),
    REPMGR_PRIMARY_HOST: `${p.name}-pg-0`,
  };

  // One pinned member per region — streaming replication, anti-affinity by region.
  const services: ServiceSpec[] = regions.map((region, i) => ({
    name: `${p.name}-pg-${i}`,
    image,
    mode: { replicated: { replicas: 1 } },
    env: { ...baseEnv, REPMGR_NODE_NAME: `${p.name}-pg-${i}`, REPMGR_PARTNER_NODES: regions.map((_, j) => `${p.name}-pg-${j}`).join(',') },
    mounts: [{ type: 'volume', source: `${p.name}-pg-${i}-data`, target: '/bitnami/postgresql' }],
    networks: [`${p.name}-net`],
    placement: pinnedToRegion(region),
  }));

  const composeServices = regions
    .map((region, i) =>
      composeService({
        name: `${p.name}-pg-${i}`,
        image,
        env: { ...baseEnv, REPMGR_NODE_NAME: `${p.name}-pg-${i}` },
        replicas: 1,
        constraints: [`node.labels.swarmy.region==${region}`],
      }),
    )
    .join('\n');

  const composeSource = [
    'version: "3.8"',
    'services:',
    composeServices,
    'volumes:',
    ...regions.map((_, i) => `  ${p.name}-pg-${i}-data:`),
    'networks:',
    `  ${p.name}-net:`,
    '    driver: overlay',
  ].join('\n');

  return {
    services,
    composeSource,
    connectionHint: `postgres://postgres@${p.name}-pg-0:5432/${baseEnv.POSTGRESQL_DATABASE}`,
    durabilityNote:
      regions.length >= 3
        ? `Survives loss of 1 region (${regions.length} regions). Streaming replication is synchronous-capable; cross-region commit adds latency.`
        : `Only ${regions.length} region(s): no quorum tiebreaker, so automatic failover is unsafe. Add a 3rd region (or a witness) for clean failover.`,
  };
}

// ───────────────────────────────────────────── redis-ha ──

const REDIS_IMAGE = 'bitnami/redis-sentinel:7';
const REDIS_DATA_IMAGE = 'bitnami/redis:7';

function renderRedisHa(p: TemplateParams): RenderedTemplate {
  const dataImage = p.image ?? REDIS_DATA_IMAGE;
  const regions = p.regions.length ? p.regions : ['default'];
  const replicasPerRegion = p.replicasPerRegion ?? 1;

  const masterEnv: Record<string, string> = {
    REDIS_PASSWORD: '${REDIS_PASSWORD:-changeme}',
    REDIS_REPLICATION_MODE: 'master',
  };
  const replicaEnv: Record<string, string> = {
    REDIS_PASSWORD: '${REDIS_PASSWORD:-changeme}',
    REDIS_MASTER_PASSWORD: '${REDIS_PASSWORD:-changeme}',
    REDIS_REPLICATION_MODE: 'replica',
    REDIS_MASTER_HOST: `${p.name}-redis-master`,
  };
  const sentinelEnv: Record<string, string> = {
    REDIS_MASTER_HOST: `${p.name}-redis-master`,
    REDIS_MASTER_PASSWORD: '${REDIS_PASSWORD:-changeme}',
    REDIS_SENTINEL_QUORUM: String(Math.floor(regions.length / 2) + 1),
  };

  const services: ServiceSpec[] = [
    {
      name: `${p.name}-redis-master`,
      image: dataImage,
      mode: { replicated: { replicas: 1 } },
      env: masterEnv,
      networks: [`${p.name}-net`],
      placement: pinnedToRegion(regions[0]!),
    },
    {
      name: `${p.name}-redis-replica`,
      image: dataImage,
      mode: { replicated: { replicas: Math.max(1, (regions.length - 1) * replicasPerRegion) } },
      env: replicaEnv,
      networks: [`${p.name}-net`],
      placement: spreadAcrossRegions(),
    },
    // One sentinel pinned per region — clean quorum across failure domains.
    ...regions.map((region, i) => ({
      name: `${p.name}-redis-sentinel-${i}`,
      image: REDIS_IMAGE,
      mode: { replicated: { replicas: 1 } },
      env: sentinelEnv,
      networks: [`${p.name}-net`],
      placement: pinnedToRegion(region),
    })),
  ];

  const composeSource = [
    'version: "3.8"',
    'services:',
    composeService({
      name: `${p.name}-redis-master`,
      image: dataImage,
      env: masterEnv,
      replicas: 1,
      constraints: [`node.labels.swarmy.region==${regions[0]}`],
    }),
    composeService({
      name: `${p.name}-redis-replica`,
      image: dataImage,
      env: replicaEnv,
      replicas: Math.max(1, (regions.length - 1) * replicasPerRegion),
      preferences: ['node.labels.swarmy.region'],
      maxReplicasPerNode: 1,
    }),
    ...regions.map((region, i) =>
      composeService({
        name: `${p.name}-redis-sentinel-${i}`,
        image: REDIS_IMAGE,
        env: sentinelEnv,
        replicas: 1,
        constraints: [`node.labels.swarmy.region==${region}`],
      }),
    ),
    'networks:',
    `  ${p.name}-net:`,
    '    driver: overlay',
  ].join('\n');

  return {
    services,
    composeSource,
    connectionHint: `Use a sentinel-aware client → ${regions.map((_, i) => `${p.name}-redis-sentinel-${i}:26379`).join(', ')} (master: ${p.name}-redis-master)`,
    durabilityNote:
      regions.length >= 3
        ? `Survives loss of 1 region (${regions.length} sentinels). Redis replication is async — a small write-loss window is possible on failover (non-zero RPO).`
        : `Only ${regions.length} region(s): sentinel quorum needs >=3 for safe automatic failover. Add a 3rd region or a witness sentinel.`,
  };
}

// ───────────────────────────────────────────── registry ──

const TEMPLATES: Record<TemplateId, TemplateDefinition> = {
  'postgres-ha': {
    id: 'postgres-ha',
    kind: 'database',
    engine: 'postgres',
    title: 'Postgres — High Availability',
    blurb: 'Primary + streaming replica, one per region. Survives a region going dark.',
    recommendedRegions: 3,
    render: renderPostgresHa,
  },
  'redis-ha': {
    id: 'redis-ha',
    kind: 'cache',
    engine: 'redis',
    title: 'Redis — High Availability',
    blurb: 'Primary + replicas + sentinels spread across regions for automatic failover.',
    recommendedRegions: 3,
    render: renderRedisHa,
  },
};

export function listTemplates(): TemplateMeta[] {
  return Object.values(TEMPLATES).map(({ render: _render, ...meta }) => meta);
}

export function getTemplate(id: TemplateId): TemplateDefinition | undefined {
  return TEMPLATES[id];
}

export function renderTemplate(id: TemplateId, params: TemplateParams): RenderedTemplate | undefined {
  return TEMPLATES[id]?.render(params);
}

// ───────────────────────────────────────────── deploy flow ──

export interface DeployTemplateInput {
  id: TemplateId;
  params: TemplateParams;
  /**
   * When true (and a host is given), seed a Geo-DNS record per region pointing
   * at the template's regional endpoint, so Part A (geo steering) and Part B
   * (HA placement) compose: a "deploy HA template across regions" flow.
   */
  geo?: {
    /** Host to expose, e.g. `db.geo.example.com`. */
    host: string;
    /** region → target ingress IP/hostname for that region's member. */
    targets?: Record<string, string>;
  };
}

export interface DeployTemplateResult {
  stackId: string;
  deploymentId: string;
  connectionHint: string;
  durabilityNote: string;
  geoRecords: number;
}

/**
 * Deploy an HA template across regions: render the placement-aware compose,
 * deploy it through the EXISTING stack pipeline (so it also runs with plain
 * `docker stack deploy`), then optionally wire Geo-DNS records so the stack's
 * regional endpoints are steerable. One form → one Deploy.
 */
export async function deployTemplate(
  ctx: OrgContext,
  input: DeployTemplateInput,
): Promise<DeployTemplateResult> {
  const rendered = renderTemplate(input.id, input.params);
  if (!rendered) throw notFound('template', input.id);

  const deploy = await deployFromCompose(ctx, {
    name: input.params.name,
    composeSource: rendered.composeSource,
  });

  // Compose with Part A: seed one Geo-DNS record per region for the endpoint.
  let geoRecords = 0;
  if (input.geo?.host) {
    const targets = input.geo.targets ?? {};
    for (const region of input.params.regions) {
      const target = targets[region];
      if (!target) continue;
      await upsertRecord(ctx, { host: input.geo.host, region, targetIngress: target }).catch(
        () => undefined,
      );
      geoRecords++;
    }
  }

  await writeAudit(ctx, {
    action: 'templates.deploy',
    targetType: 'stack',
    targetId: deploy.id,
    metadata: { template: input.id, regions: input.params.regions, geoRecords },
  });

  return {
    stackId: deploy.id,
    deploymentId: deploy.deploymentId,
    connectionHint: rendered.connectionHint,
    durabilityNote: rendered.durabilityNote,
    geoRecords,
  };
}
