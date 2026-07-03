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

/** Full render: config file + service coordinates + layout admin call. */
export function renderGarageDeployment(input: GarageRenderInput): RenderedStoreDeployment {
  const image = input.image ?? DEFAULT_GARAGE_IMAGE;
  const joined = input.members.filter((m) => m.garageNodeId);
  const adminBase = input.members[0]?.rpcHost ?? input.serviceName;
  return {
    driver: 'garage',
    files: [
      {
        path: `/etc/swarmy/${input.serviceName}/garage.toml`,
        contents: renderGarageToml(input),
        mode: 0o600,
      },
    ],
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
