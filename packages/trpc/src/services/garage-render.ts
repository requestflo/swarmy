/**
 * Pure Garage config renderer (epic: volumes-dr, P2 — replicated object store).
 *
 * No IO. Produces a `RenderedStoreDeployment` (config file + swarm service
 * coordinates + layout admin call) that the agent applies through
 * `applyStorageNode`. Kept pure so it is trivially golden-tested.
 *
 * Garage is a single static Rust binary; one config file (`garage.toml`) plus
 * an admin-API layout assignment per member is all it needs. We replicate
 * (factor N) rather than erasure-code — simplest failure model for small swarms.
 */
import { createHash } from 'node:crypto';
import { STACK_LABEL, SYSTEM_STACK, SYSTEM_STACK_LABEL } from '@swarmy/core';

/**
 * Structural copy of `RenderedStoreDeployment` from the new
 * `@swarmy/core/protocol/storage` schema (registered into the protocol index via
 * the INTEGRATION snippet). Defined here so the renderer + its golden test build
 * standalone; kept in lockstep with the Zod schema.
 */
export interface RenderedStoreDeployment {
  driver: 'garage' | 'minio' | 'none';
  files: { path: string; contents: string; mode?: number }[];
  serviceName: string;
  image: string;
  s3Port: number;
  adminPort?: number;
  /** Extra labels the agent merges onto the store service's `labels` (see the Zod schema). */
  labels?: Record<string, string>;
  /** Swarm Docker config refs (replace host-file bind mounts; see the Zod schema). */
  configs?: { source: string; target: string; mode?: number }[];
  /** Swarm placement for the store service (member pinning). */
  placement?: { constraints: string[] };
  /** `global` = one task per eligible (member) node. */
  serviceMode?: 'replicated' | 'global';
  adminApi?: {
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'GET';
    url: string;
    body?: string;
    contentType?: string;
    bearerToken?: string;
  };
  summary: string;
}

/** Pinned Garage image the agent runs as a swarm service. */
export const DEFAULT_GARAGE_IMAGE = 'dxflrs/garage:v1.0.1';

export const GARAGE_S3_PORT = 3900;
export const GARAGE_RPC_PORT = 3901;
export const GARAGE_ADMIN_PORT = 3903;

/** In-container path Garage reads its config from. */
export const GARAGE_CONFIG_PATH = '/etc/garage.toml';
/** Content-addressed Docker config name prefix: `<prefix>-<sha8>`. */
export const GARAGE_CONFIG_PREFIX = 'swarmy-garage-config';
/**
 * Swarm NODE label marking a Garage member. The store runs as ONE global-mode
 * service constrained to this label, so each member node gets exactly one task
 * that never moves (meta/data are node-local named volumes — a floating task
 * would come up empty elsewhere). A label, not `node.id==`, because swarm
 * constraints AND together: a set of member ids cannot be expressed with ids.
 * Ex-members are set to `false` (node-label writes merge, never delete).
 */
export const GARAGE_MEMBER_NODE_LABEL = 'swarmy.garage.member';

/** The rendered `garage.toml` as a content-addressed swarm Docker config. */
export function garageConfigObject(input: GarageRenderInput): { name: string; contents: string } {
  const contents = renderGarageToml(input);
  const sha8 = createHash('sha256').update(contents, 'utf8').digest('hex').slice(0, 8);
  return { name: `${GARAGE_CONFIG_PREFIX}-${sha8}`, contents };
}

/**
 * Replication factor Garage can actually satisfy: never more than the member
 * count (a factor-3 layout on 2 nodes never becomes healthy), never below 1.
 */
export function effectiveReplicationFactor(requested: number, memberCount: number): number {
  const req = Number.isFinite(requested) ? Math.floor(requested) : 1;
  return Math.max(1, Math.min(req, Math.max(1, memberCount)));
}

export interface GarageMember {
  /** swarmy Node id (used as the Garage node tag / zone hint). */
  nodeId: string;
  /** Reachable host:rpcPort for the RPC mesh (overlay DNS or ip). */
  rpcHost: string;
  /** Storage capacity to advertise for this member, in gigabytes. */
  capacityGb: number;
  /** Garage node public key (hex) once the member has joined; absent on first render. */
  garageNodeId?: string;
}

export interface GarageRenderInput {
  /** swarmy org id — namespaces the deployment. */
  orgId: string;
  serviceName: string;
  region: string;
  replicationFactor: number;
  /** Shared RPC secret (hex, 32 bytes). Generated controller-side, stored encrypted. */
  rpcSecret: string;
  /** Admin API bearer token. Generated controller-side, stored encrypted. */
  adminToken: string;
  members: GarageMember[];
  image?: string;
}

/** Render `garage.toml` for a member. Deterministic for a given input. */
export function renderGarageToml(input: GarageRenderInput): string {
  const zones = input.members.map((m) => `node:${m.nodeId}`).join(', ');
  return [
    '# Managed by swarmy (volumes-dr). Do not edit by hand.',
    `metadata_dir = "/var/lib/garage/meta"`,
    `data_dir = "/var/lib/garage/data"`,
    `db_engine = "lmdb"`,
    '',
    `replication_factor = ${input.replicationFactor}`,
    '',
    `rpc_bind_addr = "[::]:${GARAGE_RPC_PORT}"`,
    `rpc_secret = "${input.rpcSecret}"`,
    '',
    '[s3_api]',
    `s3_region = "${input.region}"`,
    `api_bind_addr = "[::]:${GARAGE_S3_PORT}"`,
    `root_domain = ".s3.${input.region}.swarmy"`,
    '',
    '[admin]',
    `api_bind_addr = "[::]:${GARAGE_ADMIN_PORT}"`,
    `admin_token = "${input.adminToken}"`,
    '',
    `# zones: ${zones}`,
    '',
  ].join('\n');
}

/**
 * Build the cluster-layout assignment body for the admin API. Each member is
 * placed in its own zone (= its swarmy node) so replication spreads across
 * physical nodes. Only members that have joined (have a `garageNodeId`) are
 * included.
 */
export function renderLayoutBody(input: GarageRenderInput): string {
  const assignments = input.members
    .filter((m) => m.garageNodeId)
    .map((m) => ({
      id: m.garageNodeId,
      zone: `node-${m.nodeId}`,
      capacity: m.capacityGb * 1_000_000_000,
      tags: [`org:${input.orgId}`],
    }));
  return JSON.stringify(assignments);
}

/**
 * Full render: service coordinates + config ref + layout admin call.
 *
 * ZERO host files: `garage.toml` rides as a content-addressed swarm Docker
 * config (`garageConfigObject`, created controller-side before dispatch), so
 * the task can start on any node and a containerised agent never has to write
 * to the host. `files` stays empty. The service is global-mode, constrained to
 * member-labelled nodes (one pinned task per member).
 */
export function renderGarageDeployment(input: GarageRenderInput): RenderedStoreDeployment {
  const image = input.image ?? DEFAULT_GARAGE_IMAGE;
  const joined = input.members.filter((m) => m.garageNodeId);
  const adminBase = input.members[0]?.rpcHost ?? input.serviceName;
  return {
    driver: 'garage',
    files: [],
    configs: [{ source: garageConfigObject(input).name, target: GARAGE_CONFIG_PATH, mode: 0o400 }],
    placement: { constraints: [`node.labels.${GARAGE_MEMBER_NODE_LABEL}==true`] },
    serviceMode: 'global',
    serviceName: input.serviceName,
    image,
    s3Port: GARAGE_S3_PORT,
    adminPort: GARAGE_ADMIN_PORT,
    // Group under the swarmy-system stack namespace (platform plumbing, not a
    // user app stack) and mark it so the UI can tell system stacks apart.
    labels: { [STACK_LABEL]: SYSTEM_STACK, [SYSTEM_STACK_LABEL]: 'true' },
    adminApi: joined.length
      ? {
          method: 'POST',
          url: `http://${adminBase}:${GARAGE_ADMIN_PORT}/v1/layout`,
          body: renderLayoutBody(input),
          contentType: 'application/json',
          bearerToken: input.adminToken,
        }
      : undefined,
    summary: `Garage ${image} · ${input.members.length} member(s) · replication x${input.replicationFactor} · region ${input.region}`,
  };
}
