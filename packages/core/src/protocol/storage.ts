/**
 * Storage & volume orchestration wire protocol (epic: volumes-dr, P2+).
 *
 * Two concerns, both riding the existing command/result plumbing:
 *
 *  - `applyStorageNode` — bring up / reconfigure a swarmy-managed object store
 *    member (Garage) on a node: write the rendered config files then apply the
 *    cluster layout via the store's admin API. Mirrors `applyIngress`.
 *  - `provisionVolume` / `removeVolume` — create or drop a Docker volume, either
 *    a plain `local` volume or a Swarm CSI *cluster* volume (we orchestrate an
 *    existing CSI plugin — we do NOT ship a driver).
 *
 * Results are reported through the existing `commandResult` path.
 */
import { z } from 'zod';
import { CommandId } from './primitives';

/** Reusable command preamble (every controller→agent command carries these). */
const cmd = { commandId: CommandId, timeoutMs: z.number().int().positive().optional() };

// ── applyStorageNode (Garage member) ─────────────────────────────────────────

/** A config file the agent writes on the node before bringing the store up. */
export const StorageFile = z.object({
  path: z.string(),
  contents: z.string(),
  mode: z.number().int().default(0o600),
});
export type StorageFile = z.infer<typeof StorageFile>;

/**
 * Output of the storage driver's `render()`. Produced controller-side by
 * `replicatedStore.service`, carried verbatim to the agent. The agent writes
 * `files`, deploys/updates the store swarm service, then (optionally) calls the
 * admin API to apply the cluster layout.
 */
export const RenderedStoreDeployment = z.object({
  driver: z.enum(['garage', 'minio', 'none']),
  /** Config files to write (e.g. `garage.toml`). */
  files: z.array(StorageFile).default([]),
  /** The swarm service spec for the store member (handed to the existing deploy path). */
  serviceName: z.string(),
  image: z.string(),
  /** Published S3 API port. */
  s3Port: z.number().int().positive(),
  /** Admin API port (Garage layout/status). */
  adminPort: z.number().int().positive().optional(),
  /** Optional layout/admin call to run after the service is up. */
  adminApi: z
    .object({
      method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE', 'GET']),
      url: z.string(),
      body: z.string().optional(),
      contentType: z.string().default('application/json'),
      bearerToken: z.string().optional(),
    })
    .optional(),
  /** Human-inspectable summary for the preview UI. */
  summary: z.string().default(''),
});
export type RenderedStoreDeployment = z.infer<typeof RenderedStoreDeployment>;

export const ApplyStorageNodePayload = z.object({ ...cmd, rendered: RenderedStoreDeployment });
export type ApplyStorageNodePayload = z.infer<typeof ApplyStorageNodePayload>;
export const ApplyStorageNodeMsg = z.object({
  type: z.literal('applyStorageNode'),
  payload: ApplyStorageNodePayload,
});
export type ApplyStorageNodeMsg = z.infer<typeof ApplyStorageNodeMsg>;

export const ApplyStorageNodeResult = z.object({
  driver: z.string(),
  serviceId: z.string(),
  layoutApplied: z.boolean(),
});
export type ApplyStorageNodeResult = z.infer<typeof ApplyStorageNodeResult>;

// ── provisionVolume / removeVolume (CSI cluster volumes) ─────────────────────

/** Where a clustered volume may be published. */
export const VolumeAccessMode = z.enum(['single-writer', 'multi-writer', 'multi-reader']);
export type VolumeAccessMode = z.infer<typeof VolumeAccessMode>;

/**
 * A volume to create on the node. `mode: local` → a normal Docker volume.
 * `mode: cluster` → a Swarm CSI cluster volume (`docker volume create
 * --driver <csiDriver> --type cluster`), which Swarm can republish across
 * nodes for true failover. The CSI plugin itself is the user's choice and must
 * already be installed on the manager nodes — we orchestrate, we don't ship it.
 */
export const VolumeSpec = z.object({
  name: z.string(),
  mode: z.enum(['local', 'cluster']),
  /** Required when `mode: cluster` — the installed CSI plugin name. */
  csiDriver: z.string().optional(),
  accessMode: VolumeAccessMode.default('single-writer'),
  /** Optional capacity hint in bytes for cluster volumes. */
  capacityBytes: z.number().int().positive().optional(),
  /** Driver-specific create options / topology requirements. */
  options: z.record(z.string()).default({}),
});
export type VolumeSpec = z.infer<typeof VolumeSpec>;

export const ProvisionVolumePayload = z.object({ ...cmd, spec: VolumeSpec });
export type ProvisionVolumePayload = z.infer<typeof ProvisionVolumePayload>;
export const ProvisionVolumeMsg = z.object({
  type: z.literal('provisionVolume'),
  payload: ProvisionVolumePayload,
});
export type ProvisionVolumeMsg = z.infer<typeof ProvisionVolumeMsg>;

export const RemoveVolumePayload = z.object({ ...cmd, name: z.string(), cluster: z.boolean().default(false) });
export type RemoveVolumePayload = z.infer<typeof RemoveVolumePayload>;
export const RemoveVolumeMsg = z.object({
  type: z.literal('removeVolume'),
  payload: RemoveVolumePayload,
});
export type RemoveVolumeMsg = z.infer<typeof RemoveVolumeMsg>;

export const ProvisionVolumeResult = z.object({
  name: z.string(),
  mode: z.enum(['local', 'cluster']),
  created: z.boolean(),
});
export type ProvisionVolumeResult = z.infer<typeof ProvisionVolumeResult>;
