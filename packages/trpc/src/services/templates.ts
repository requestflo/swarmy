import {
  MANAGED_PG_ROOT,
  pgBootCommand,
  pgPrimaryEnv,
  pgReplicaEnv,
} from '@swarmy/core';
import { DEFAULT_MANAGED_PG_IMAGE, type ServiceSpec } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { notFound } from '../errors';
import { deployFromCompose } from './stack.service';
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
 * MVP ships two: `postgres-ha` (streaming primary + replicas) and `redis-ha`
 * (Valkey primary + replicas + sentinels). Both are region/anti-affinity aware
 * and run OFFICIAL upstream images only (pgvector/pgvector = official postgres
 * + pgvector; valkey/valkey) under swarmy's small `sh -c` boot layer.
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

/** Compose interpolates `$VAR` in every string — a literal shell `$` is `$$`. */
export function composeEscape(v: string): string {
  return v.replace(/\$/g, '$$$$');
}

function composeService(opts: {
  name: string;
  image: string;
  env?: Record<string, string>;
  /** Overrides the image ENTRYPOINT (the swarm spec's `command`). `$` is escaped for compose. */
  entrypoint?: string[];
  command?: string[];
  replicas?: number;
  constraints?: string[];
  preferences?: string[];
  maxReplicasPerNode?: number;
  /** Compose short-form volume mounts (`name:/path`). */
  volumes?: string[];
}): string {
  const lines: string[] = [`  ${opts.name}:`, `    image: ${opts.image}`];
  if (opts.volumes?.length) {
    lines.push('    volumes:');
    for (const v of opts.volumes) lines.push(`      - ${v}`);
  }
  if (opts.entrypoint?.length) {
    lines.push(`    entrypoint: ${JSON.stringify(opts.entrypoint.map(composeEscape))}`);
  }
  if (opts.command?.length) {
    lines.push(`    command: ${JSON.stringify(opts.command.map(composeEscape))}`);
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

/**
 * postgres-ha: member 0 is the writer, members 1..n stream from it — the same
 * swarmy boot layer the managed plane uses (@swarmy/core manageddb-pg: the
 * replication role + pg_hba on the writer, `pg_basebackup` replicas), on the
 * official image contract. The portable template has NO automatic promotion:
 * a compose stack has no controller to prove a replica caught up, and a
 * blind promote can lose writes. Automatic, provably-safe failover is the
 * managed cluster's job (`failover` topology, `decideFailover`).
 */
function renderPostgresHa(p: TemplateParams): RenderedTemplate {
  const image = p.image ?? DEFAULT_MANAGED_PG_IMAGE;
  const regions = p.regions.length ? p.regions : ['default'];
  const database = p.name.replace(/[^a-z0-9_]/gi, '_');
  const writer = `${p.name}-pg-0`;
  const creds = {
    password: '${POSTGRES_PASSWORD:-changeme}',
    replicationUser: 'repl',
    replicationPassword: '${REPLICATION_PASSWORD:-changeme}',
  };
  const envFor = (i: number): Record<string, string> =>
    i === 0
      ? pgPrimaryEnv({ ...creds, database })
      : pgReplicaEnv({ ...creds, primaryHost: writer, primaryPort: 5432 });
  const boot = pgBootCommand();

  // One pinned member per region — streaming replication, anti-affinity by region.
  const services: ServiceSpec[] = regions.map((region, i) => ({
    name: `${p.name}-pg-${i}`,
    image,
    mode: { replicated: { replicas: 1 } },
    command: boot,
    env: envFor(i),
    mounts: [{ type: 'volume', source: `${p.name}-pg-${i}-data`, target: MANAGED_PG_ROOT }],
    networks: [`${p.name}-net`],
    placement: pinnedToRegion(region),
  }));

  const composeServices = regions
    .map((region, i) =>
      composeService({
        name: `${p.name}-pg-${i}`,
        image,
        entrypoint: boot,
        env: envFor(i),
        replicas: 1,
        constraints: [`node.labels.swarmy.region==${region}`],
        // Persist each member's data on its declared named volume (deployed as
        // `<stack>_<name>-pg-<i>-data` — docker stack naming).
        volumes: [`${p.name}-pg-${i}-data:${MANAGED_PG_ROOT}`],
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
    connectionHint: `postgres://postgres@${writer}:5432/${database} (read-only: ${p.name}-pg-1..${regions.length - 1})`,
    durabilityNote:
      `Async streaming replication across ${regions.length} region(s); promotion is MANUAL ` +
      '(SELECT pg_promote() on a caught-up replica) — for automatic, never-lose-data failover use a managed Postgres cluster with the failover topology.',
  };
}

// ───────────────────────────────────────────── redis-ha ──

const VALKEY_IMAGE = 'valkey/valkey:8';

/** Valkey server command; the password comes from the member's env. */
function valkeyServer(replicaOf?: string): string {
  return [
    'exec valkey-server --requirepass "$VALKEY_PASSWORD" --masterauth "$VALKEY_PASSWORD" --appendonly yes --dir /data',
    ...(replicaOf ? [`--replicaof ${replicaOf} 6379`] : []),
  ].join(' ');
}

/** Sentinel: follow a live peer's view of the master first, else the seeded master. */
function valkeySentinel(p: TemplateParams, quorum: number, regions: string[]): string {
  const master = `${p.name}-redis-master`;
  const peers = regions.map((_, i) => `${p.name}-redis-sentinel-${i}`).join(' ');
  return [
    'set -eu',
    `MASTER=${master}; MPORT=6379`,
    `for h in ${peers}; do`,
    '  A="$(timeout 3 valkey-cli -h "$h" -p 26379 --raw SENTINEL get-master-addr-by-name main 2>/dev/null | head -n 2 | tr \'\\n\' \' \' || true)"',
    '  set -- $A',
    '  if [ -n "${1:-}" ] && [ -n "${2:-}" ]; then MASTER="$1"; MPORT="$2"; break; fi',
    'done',
    'cat > /tmp/sentinel.conf <<EOF',
    'port 26379',
    'sentinel resolve-hostnames yes',
    'sentinel announce-hostnames yes',
    `sentinel monitor main $MASTER $MPORT ${quorum}`,
    'sentinel auth-pass main $VALKEY_PASSWORD',
    'EOF',
    'exec valkey-sentinel /tmp/sentinel.conf',
  ].join('\n');
}

function renderRedisHa(p: TemplateParams): RenderedTemplate {
  const image = p.image ?? VALKEY_IMAGE;
  const regions = p.regions.length ? p.regions : ['default'];
  const replicasPerRegion = p.replicasPerRegion ?? 1;
  const quorum = Math.floor(regions.length / 2) + 1;
  const env: Record<string, string> = { VALKEY_PASSWORD: '${REDIS_PASSWORD:-changeme}' };
  const master = `${p.name}-redis-master`;
  const sh = (script: string) => ['sh', '-c', script];
  const replicaCount = Math.max(1, (regions.length - 1) * replicasPerRegion);

  const services: ServiceSpec[] = [
    {
      name: master,
      image,
      mode: { replicated: { replicas: 1 } },
      command: sh(valkeyServer()),
      env,
      networks: [`${p.name}-net`],
      placement: pinnedToRegion(regions[0]!),
    },
    {
      name: `${p.name}-redis-replica`,
      image,
      mode: { replicated: { replicas: replicaCount } },
      command: sh(valkeyServer(master)),
      env,
      networks: [`${p.name}-net`],
      placement: spreadAcrossRegions(),
    },
    // One sentinel pinned per region — clean quorum across failure domains.
    ...regions.map((region, i) => ({
      name: `${p.name}-redis-sentinel-${i}`,
      image,
      mode: { replicated: { replicas: 1 } },
      command: sh(valkeySentinel(p, quorum, regions)),
      env,
      networks: [`${p.name}-net`],
      placement: pinnedToRegion(region),
    })),
  ];

  const composeSource = [
    'version: "3.8"',
    'services:',
    composeService({
      name: master,
      image,
      entrypoint: sh(valkeyServer()),
      env,
      replicas: 1,
      constraints: [`node.labels.swarmy.region==${regions[0]}`],
    }),
    composeService({
      name: `${p.name}-redis-replica`,
      image,
      entrypoint: sh(valkeyServer(master)),
      env,
      replicas: replicaCount,
      preferences: ['node.labels.swarmy.region'],
      maxReplicasPerNode: 1,
    }),
    ...regions.map((region, i) =>
      composeService({
        name: `${p.name}-redis-sentinel-${i}`,
        image,
        entrypoint: sh(valkeySentinel(p, quorum, regions)),
        env,
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
    connectionHint: `Use a sentinel-aware client → ${regions.map((_, i) => `${p.name}-redis-sentinel-${i}:26379`).join(', ')} (master set: main)`,
    durabilityNote:
      regions.length >= 3
        ? `Survives loss of 1 region (${regions.length} sentinels). Valkey replication is async — a small write-loss window is possible on failover (non-zero RPO).`
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
    blurb: 'Primary + streaming replicas, one per region (official Postgres + pgvector). Manual promotion.',
    recommendedRegions: 3,
    render: renderPostgresHa,
  },
  'redis-ha': {
    id: 'redis-ha',
    kind: 'cache',
    engine: 'redis',
    title: 'Valkey (Redis-compatible) — High Availability',
    blurb: 'Valkey primary + replicas + sentinels spread across regions for automatic failover.',
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

  // `composeSource` is written for `docker stack deploy`, which interpolates
  // `$VAR` and needs a literal shell `$` spelled `$$`. swarmy's compose pipeline
  // does not interpolate, so undo the escape for the swarmy deploy.
  const deploy = await deployFromCompose(ctx, {
    name: input.params.name,
    composeSource: rendered.composeSource.replace(/\$\$/g, '$'),
  });

  // Geo-DNS records are DERIVED now (attach a domain via ingress and the
  // nameserver answers automatically — docs/product/edge-network.md), so the
  // old per-region record seeding is gone. `geoRecords` stays for API shape.
  const geoRecords = 0;

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
