import { z } from 'zod';

// Wire/render types are owned by @swarmy/core so the agent and the controller
// share one definition. The mesh package re-exports them (mirrors @swarmy/ingress).
export {
  RenderedMesh,
  MeshRenderedFile,
  MeshEnrollment,
  MeshStatus,
  MeshDriverName,
} from '@swarmy/core/protocol';
export type {
  RenderedMesh as RenderedMeshT,
  MeshEnrollment as MeshEnrollmentT,
  MeshStatus as MeshStatusT,
} from '@swarmy/core/protocol';

import type { MeshEnrollment, MeshStatus, RenderedMesh } from '@swarmy/core/protocol';

// ── Org-scoped config (persisted, controller-side) ─────────────────────

export const MeshControlPlaneSchema = z.object({
  /** Where the control plane lives relative to swarmy. */
  mode: z.enum(['managed-by-swarmy', 'external']).default('external'),
  /** NetBird management server URL. */
  url: z.string().optional(),
  /**
   * Plaintext secrets are NEVER stored here — the controller resolves the API
   * service token from the credential vault at provision/dispatch time and
   * injects it just-in-time. This carries the *resolved* token for that call.
   */
  serviceToken: z.string().optional(),
});
export type MeshControlPlane = z.infer<typeof MeshControlPlaneSchema>;

export const MeshConfigSchema = z.object({
  driver: z.string().min(1),
  enabled: z.boolean().default(false),
  orgId: z.string(),
  managementUrl: z.string().optional(),
  controlPlane: MeshControlPlaneSchema.default({}),
  /** Driver-typed escape hatch (client image, default routes, …). */
  settings: z.record(z.unknown()).default({}),
});
export type MeshConfig = z.infer<typeof MeshConfigSchema>;

export type MeshValidationResult =
  | { ok: true }
  | { ok: false; errors: { path: string; message: string }[] };

/** Options for provisioning a node's mesh membership. */
export interface ProvisionNodeOpts {
  nodeId: string;
  /** Subnet routes this node should advertise into the mesh. */
  advertiseRoutes?: string[];
}

/**
 * How a driver talks to its provider's Admin API (impl in apps/api / the tRPC
 * service). Driver code is transport-agnostic — it only calls these. Mirrors
 * `DriverDispatch` in @swarmy/ingress (here it abstracts the control plane).
 */
export interface DriverControlPlane {
  /** Mint a single-use, short-TTL setup/pre-auth key for one node. */
  createSetupKey(opts: { nodeId: string; ephemeral?: boolean }): Promise<{ setupKey: string }>;
  /** List the provider's known peers (for reconciliation). */
  listPeers(): Promise<MeshPeerInfo[]>;
  /** Revoke a peer by its provider id. */
  revokePeer(peerId: string): Promise<void>;
}

/** A provider peer as reported by the control plane. */
export interface MeshPeerInfo {
  peerId: string;
  nodeId?: string;
  meshIp?: string;
  connected: boolean;
  lastSeen?: string;
}

export interface MeshDriver {
  readonly name: string;
  validate(config: MeshConfig): MeshValidationResult;
  /**
   * Control-plane side: mint a setup key / pre-auth key, assign groups. Pure
   * apart from the injected {@link DriverControlPlane}.
   */
  provisionNode(
    config: MeshConfig,
    opts: ProvisionNodeOpts,
    control: DriverControlPlane,
  ): Promise<MeshEnrollment>;
  /** Pure, no IO — what the agent applies. */
  render(config: MeshConfig, enrollment: MeshEnrollment): RenderedMesh;
  /** Reconcile live status from the control plane (best-effort). */
  status(config: MeshConfig, control: DriverControlPlane): Promise<MeshStatus>;
}
