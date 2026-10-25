import { z } from 'zod';

// Wire/render types are owned by @swarmy/core so the agent and the controller
// share one definition. The mesh package re-exports them (mirrors @swarmy/ingress).
export {
  RenderedMesh,
  MeshEnrollment,
  MeshStatus,
  MeshDriverName,
  MeshClientKind,
} from '@swarmy/core/protocol';
export type {
  RenderedMesh as RenderedMeshT,
  MeshEnrollment as MeshEnrollmentT,
  MeshStatus as MeshStatusT,
} from '@swarmy/core/protocol';

import type { MeshEnrollment, MeshStatus, RenderedMesh } from '@swarmy/core/protocol';
import type { NetbirdAdminApi } from './control-plane/netbird-admin';

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
  /**
   * The provider's groups + policies (NetBird's Admin API shape), when the
   * control plane has one. Optional: the opaque-key stub has none. Only a
   * driver that implements the access-rule methods below reads it.
   */
  policies?: PolicyAdminApi;
}

/** The slice of the NetBird Admin API access rules need. */
export type PolicyAdminApi = Pick<NetbirdAdminApi, 'listGroups' | 'listPolicies' | 'createPolicy' | 'deletePolicy'>;

/** One access rule on the mesh: which groups can reach which, on which ports. */
export interface MeshAccessRule {
  /** The provider's policy id (NetBird; `<policy>:<n>` for the n-th rule of a multi-rule policy). */
  id: string;
  name: string;
  enabled: boolean;
  /** Group names on each side. */
  from: string[];
  to: string[];
  /** The destination is a network resource (a service people reach), not a group. */
  toResource: boolean;
  protocol: 'all' | 'tcp' | 'udp' | 'icmp';
  /** Single ports or `a-b` ranges; empty = every port of `protocol`. */
  ports: string[];
  bidirectional: boolean;
  action: 'accept' | 'drop';
  /** swarmy keeps this one itself (servers ↔ servers, people access): listed, never changed here. */
  managedBySwarmy: boolean;
  /** One accept rule from a group to a group, nothing more: swarmy can remove it. */
  simple: boolean;
}

/** A simple rule to add: one group may reach another on some ports. */
export interface NewMeshAccessRule {
  from: string;
  to: string;
  protocol: 'tcp' | 'udp' | 'all';
  /** Single ports; empty = every port of `protocol` (and must be empty for `all`). */
  ports: number[];
}

export interface MeshAccessList {
  rules: MeshAccessRule[];
  /** Groups a new rule may name: the provider's own, never swarmy's or "All". */
  groups: string[];
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
  /**
   * Optional: the mesh's access rules (who can reach whom). NetBird implements
   * them over its policies; Headscale leaves them out (its ACL is a policy
   * file swarmy doesn't read yet), and so does `none`. Callers check for the
   * method, never the driver name.
   */
  listAccessRules?(config: MeshConfig, control: DriverControlPlane): Promise<MeshAccessList>;
  addAccessRule?(config: MeshConfig, rule: NewMeshAccessRule, control: DriverControlPlane): Promise<MeshAccessRule>;
  /** Removes a simple rule that isn't swarmy's own (refuses anything else). */
  removeAccessRule?(config: MeshConfig, id: string, control: DriverControlPlane): Promise<void>;
}

