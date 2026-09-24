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
import { garageMajorOf, toGarageRequest } from './garage-admin';
import { createHash } from 'node:crypto';
import { STACK_LABEL, SWARMY_OVERLAY_NETWORK, SYSTEM_STACK, SYSTEM_STACK_LABEL } from '@swarmy/core';

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
  /** Swarm Docker SECRET refs (rpc secret / admin token; see the Zod schema). */
  secrets?: { source: string; target: string; mode?: number }[];
  /** Swarm placement for the store service (member pinning). */
  placement?: { constraints: string[] };
  /** `global` = one task per eligible (member) node. */
  serviceMode?: 'replicated' | 'global';
  /** Overlay networks the store joins; present ⇒ the agent publishes NO ports (see the Zod schema). */
  networks?: string[];
  adminApi?: {
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'GET';
    url: string;
    body?: string;
    contentType?: string;
    bearerToken?: string;
  };
  summary: string;
}

/**
 * Garage image NEW stores start on. An existing store keeps the engine it
 * runs (`StorageCluster.engineImage`, null = {@link LEGACY_GARAGE_IMAGE}) until
 * an engine upgrade moves it — a major is not a rolling upgrade, so a redeploy
 * must never pick this up silently. v2 is also what makes uploads from current
 * AWS SDKs work (unsigned-trailer + CRC64NVME checksums; v1.x rejects them).
 */
export const DEFAULT_GARAGE_IMAGE = 'dxflrs/garage:v2.4.1';

export const GARAGE_S3_PORT = 3900;
export const GARAGE_RPC_PORT = 3901;
export const GARAGE_ADMIN_PORT = 3903;

/**
 * The overlay the store joins. Private-only: NO published ports — S3 (3900),
 * RPC (3901) and admin (3903) are reached by swarm DNS on this attachable
 * overlay (`swarmy-garage:3900` for restic sidecars + attached apps; admin
 * calls are one-shot curl containers attached to it).
 */
export const GARAGE_NETWORK = SWARMY_OVERLAY_NETWORK;

/** Admin API base as seen from a one-shot container on {@link GARAGE_NETWORK}. */
export function garageAdminUrl(serviceName: string): string {
  return `http://${serviceName}:${GARAGE_ADMIN_PORT}/v1`;
}

/** Admin API root (no version prefix — {@link toGarageRequest} adds `/v1` or `/v2`). */
export function garageAdminRoot(serviceName: string): string {
  return `http://${serviceName}:${GARAGE_ADMIN_PORT}`;
}

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

/**
 * Garage secrets ride as swarm Docker SECRETS — never inside `garage.toml`
 * (a Docker config is readable by anyone with `docker config inspect` on a
 * manager). The toml points at them with `rpc_secret_file` / `admin_token_file`
 * (supported since Garage v0.8.2). Names are content-addressed
 * (`<prefix>-<sha8>`) so a rotated value is a new secret + a service update;
 * the in-container target is stable so the toml never changes on rotation.
 */
export const GARAGE_RPC_SECRET_PREFIX = 'swarmy-garage-rpc-secret';
export const GARAGE_ADMIN_TOKEN_PREFIX = 'swarmy-garage-admin-token';
/** File names under `/run/secrets/` (stable across rotations). */
export const GARAGE_RPC_SECRET_TARGET = 'garage-rpc-secret';
export const GARAGE_ADMIN_TOKEN_TARGET = 'garage-admin-token';
/** Label marking a Docker secret as part of the object store (sweep scope). */
export const GARAGE_SECRET_LABEL = 'swarmy.storage.secret';

function sha8(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8);
}

/** The rendered `garage.toml` as a content-addressed swarm Docker config. */
export function garageConfigObject(input: GarageRenderInput): { name: string; contents: string } {
  const contents = renderGarageToml(input);
  return { name: `${GARAGE_CONFIG_PREFIX}-${sha8(contents)}`, contents };
}

/** One Docker secret the controller `secret.create`s before `storage.apply`. */
export interface GarageSecretObject {
  name: string;
  /** Plaintext — goes only onto the (authenticated) wire → Docker API. */
  value: string;
  /** File name under `/run/secrets/`. */
  target: string;
}

/** The store's secrets (rpc secret + admin token) as content-addressed Docker secrets. */
export function garageSecretObjects(input: Pick<GarageRenderInput, 'rpcSecret' | 'adminToken'>): {
  rpcSecret: GarageSecretObject;
  adminToken: GarageSecretObject;
} {
  return {
    rpcSecret: {
      name: `${GARAGE_RPC_SECRET_PREFIX}-${sha8(input.rpcSecret)}`,
      value: input.rpcSecret,
      target: GARAGE_RPC_SECRET_TARGET,
    },
    adminToken: {
      name: `${GARAGE_ADMIN_TOKEN_PREFIX}-${sha8(input.adminToken)}`,
      value: input.adminToken,
      target: GARAGE_ADMIN_TOKEN_TARGET,
    },
  };
}

/** Whether a Docker secret name is one of the store's (sweep scope). */
export function isGarageSecretName(name: string): boolean {
  return name.startsWith(`${GARAGE_RPC_SECRET_PREFIX}-`) || name.startsWith(`${GARAGE_ADMIN_TOKEN_PREFIX}-`);
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

/**
 * Render `garage.toml` for a member. Deterministic for a given input. Carries
 * NO secret material: `rpc_secret_file` / `admin_token_file` point at the
 * mounted Docker secrets (Garage refuses world-readable secret files, so the
 * refs are mode 0400 — the image runs as root).
 */
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
    `rpc_secret_file = "/run/secrets/${GARAGE_RPC_SECRET_TARGET}"`,
    '',
    '[s3_api]',
    `s3_region = "${input.region}"`,
    `api_bind_addr = "[::]:${GARAGE_S3_PORT}"`,
    `root_domain = ".s3.${input.region}.swarmy"`,
    '',
    '[admin]',
    `api_bind_addr = "[::]:${GARAGE_ADMIN_PORT}"`,
    `admin_token_file = "/run/secrets/${GARAGE_ADMIN_TOKEN_TARGET}"`,
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
  return {
    driver: 'garage',
    files: [],
    configs: [{ source: garageConfigObject(input).name, target: GARAGE_CONFIG_PATH, mode: 0o400 }],
    secrets: Object.values(garageSecretObjects(input)).map((s) => ({
      source: s.name,
      target: s.target,
      mode: 0o400,
    })),
    placement: { constraints: [`node.labels.${GARAGE_MEMBER_NODE_LABEL}==true`] },
    serviceMode: 'global',
    // Overlay-only: the agent publishes no ports when `networks` is set.
    networks: [GARAGE_NETWORK],
    serviceName: input.serviceName,
    image,
    s3Port: GARAGE_S3_PORT,
    adminPort: GARAGE_ADMIN_PORT,
    // Group under the swarmy-system stack namespace (platform plumbing, not a
    // user app stack) and mark it so the UI can tell system stacks apart.
    labels: { [STACK_LABEL]: SYSTEM_STACK, [SYSTEM_STACK_LABEL]: 'true' },
    adminApi: joined.length
      ? (() => {
          // Same call in the engine's own dialect (v2 wants `{roles}` at /v2/UpdateClusterLayout).
          const req = toGarageRequest({ method: 'POST', path: '/layout', body: renderLayoutBody(input) }, garageMajorOf(image));
          return {
            method: req.method,
            // Resolved on the overlay by a one-shot container, never the agent process.
            url: `${garageAdminRoot(input.serviceName)}${req.path}`,
            body: req.body ?? '',
            contentType: 'application/json',
            bearerToken: input.adminToken,
          };
        })()
      : undefined,
    summary: `Garage ${image} · ${input.members.length} member(s) · replication x${input.replicationFactor} · region ${input.region}`,
  };
}
