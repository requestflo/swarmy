import { z } from 'zod';
import { CommandId } from './primitives';

/**
 * Zero-trust mesh networking protocol (epic #6). Mirrors `ingress.ts`:
 * wire/render types are owned by `@swarmy/core` so the agent and the controller
 * share one definition; `@swarmy/mesh` re-exports them. The controller's mesh
 * driver `render()`s a driver-agnostic {@link RenderedMesh}, carried verbatim to
 * the agent inside `applyMesh`. The agent installs/joins the mesh client; it
 * never reasons about which provider it is — adding a provider is a new driver,
 * never an agent rewrite (generic-intent principle, same as
 * `RenderedConfig`/`applyIngress`).
 *
 * Secrets travel BY REFERENCE: the controller resolves a single-use setup key /
 * pre-auth key from the credential vault at dispatch time and injects it just-
 * in-time into `RenderedMesh.client.*Key` for the one frame that is sent — it is
 * never persisted in plaintext.
 *
 * NOTE FOR THE INTEGRATOR: the `ApplyMeshMsg` is already wired into
 * `ControllerToAgentMessage`; the NEW `MeshStateMsg` (agent→controller telemetry,
 * Phase 2+) must be added to `AgentToControllerMessage` — see INTEGRATION.
 */

/** Wire-level driver name. Mirrors the DB `MeshDriver` enum (lowercased). */
export const MeshDriverName = z.enum([
  'netbird',
  'headscale',
  'tailscale',
  'wireguard',
  'none',
]);
export type MeshDriverName = z.infer<typeof MeshDriverName>;

/** Which on-node client a {@link RenderedMesh} drives. */
export const MeshClientKind = z.enum(['netbird', 'tailscale', 'wireguard', 'none']);
export type MeshClientKind = z.infer<typeof MeshClientKind>;

/** A config file the agent should write on the node (e.g. a `wg0.conf`). */
export const MeshRenderedFile = z.object({
  path: z.string(),
  contents: z.string(),
  /** POSIX mode, e.g. 0o600 — agent applies it when writing. */
  mode: z.number().int().default(0o600),
});
export type MeshRenderedFile = z.infer<typeof MeshRenderedFile>;

/**
 * The node-facing enrollment a driver mints control-plane-side: everything the
 * agent needs to join the mesh. Keys are single-use + short-TTL and resolved
 * from the vault just-in-time (never persisted in clear).
 */
export const MeshEnrollment = z.object({
  driver: MeshDriverName,
  /** Control-plane management server URL (NetBird/Headscale self-hosted/external). */
  managementUrl: z.string().optional(),
  /** NetBird single-use setup key (resolved JIT from the vault). */
  setupKey: z.string().optional(),
  /** Headscale/Tailscale pre-auth / auth key (resolved JIT from the vault). */
  authKey: z.string().optional(),
  /** Tailscale tailnet (org) the node joins. */
  tailnet: z.string().optional(),
  /** WireGuard keypair + peers for the raw-WireGuard driver. */
  wireguard: z
    .object({
      address: z.string(),
      privateKey: z.string(),
      listenPort: z.number().int().positive().default(51820),
      dns: z.array(z.string()).default([]),
      peers: z
        .array(
          z.object({
            publicKey: z.string(),
            endpoint: z.string().optional(),
            allowedIps: z.array(z.string()).default([]),
            persistentKeepalive: z.number().int().nonnegative().optional(),
          }),
        )
        .default([]),
    })
    .optional(),
  /** WireGuard interface name the client will create, e.g. `wt0` / `wg0` / `tailscale0`. */
  interface: z.string().default('wt0'),
  /** Subnet routes this node should advertise into the mesh. */
  advertiseRoutes: z.array(z.string()).default([]),
  /** Accept routes advertised by other peers. */
  acceptRoutes: z.boolean().default(true),
});
export type MeshEnrollment = z.infer<typeof MeshEnrollment>;

/**
 * Full output of a mesh driver's `render()` — the mesh analog of
 * `RenderedConfig`. Carried verbatim to the agent inside `applyMesh`. For
 * NetBird/Tailscale the agent runs/joins the official client container using
 * `client`; for the raw-WireGuard driver it writes `files` then runs
 * `reloadCommand` (`wg-quick up wg0`).
 */
export const RenderedMesh = z.object({
  driver: MeshDriverName,
  action: z.enum(['join', 'leave', 'reconfigure']).default('join'),
  client: z
    .object({
      kind: MeshClientKind,
      /** Client container image (pin a digest in prod). */
      image: z.string().optional(),
      managementUrl: z.string().optional(),
      /** NetBird single-use setup key (resolved JIT — only on the dispatched frame). */
      setupKey: z.string().optional(),
      /** Headscale/Tailscale auth key (resolved JIT — only on the dispatched frame). */
      authKey: z.string().optional(),
      tailnet: z.string().optional(),
      interface: z.string().default('wt0'),
      advertiseRoutes: z.array(z.string()).default([]),
      acceptRoutes: z.boolean().default(true),
    })
    .optional(),
  /** Files to write (raw-WireGuard-style drivers). */
  files: z.array(MeshRenderedFile).default([]),
  /** Optional post-write reload (e.g. `wg-quick up wg0`). */
  reloadCommand: z.array(z.string()).optional(),
  /** Human-inspectable summary for previews / the Networking UI. */
  summary: z.string().default(''),
});
export type RenderedMesh = z.infer<typeof RenderedMesh>;

/** Live mesh membership status (for display + reconciliation). */
export const MeshStatus = z.object({
  driver: MeshDriverName,
  connected: z.boolean(),
  meshIp: z.string().optional(),
  peerId: z.string().optional(),
  interface: z.string().optional(),
  relayed: z.boolean().default(false),
  lastHandshakeAt: z.string().optional(),
  message: z.string().optional(),
});
export type MeshStatus = z.infer<typeof MeshStatus>;

export const ApplyMeshPayload = z.object({
  commandId: CommandId,
  timeoutMs: z.number().int().positive().optional(),
  rendered: RenderedMesh,
});
export type ApplyMeshPayload = z.infer<typeof ApplyMeshPayload>;

export const ApplyMeshMsg = z.object({
  type: z.literal('applyMesh'),
  payload: ApplyMeshPayload,
});
export type ApplyMeshMsg = z.infer<typeof ApplyMeshMsg>;

/** Typed `applyMesh` result for controller-side narrowing (in CommandResultMap). */
export interface ApplyMeshResult {
  driver: MeshDriverName;
  joined: boolean;
  meshIp?: string;
  peerId?: string;
}

// ── Direct-stack-connect: control-plane access intent (Phase 2) ──────────────

/**
 * A grant command pushed to a node-local WireGuard driver when there is no
 * control plane to enforce ACLs (the raw-WireGuard escape hatch). For
 * NetBird/Headscale/Tailscale most enforcement is control-plane side via
 * `applyAccess`; this command lets the `wireguard` driver gate locally.
 */
export const GrantDirectRoutePayload = z.object({
  commandId: CommandId,
  timeoutMs: z.number().int().positive().optional(),
  /** The mesh peer (public key / id) being granted. */
  principal: z.object({ publicKey: z.string().optional(), peerId: z.string().optional() }),
  /** What it may reach: a CIDR or host:port the agent allows. */
  target: z.object({ cidr: z.string().optional(), host: z.string().optional(), port: z.number().int().optional() }),
  action: z.enum(['grant', 'revoke']).default('grant'),
});
export type GrantDirectRoutePayload = z.infer<typeof GrantDirectRoutePayload>;

export const GrantDirectRouteMsg = z.object({
  type: z.literal('grantDirectRoute'),
  payload: GrantDirectRoutePayload,
});
export type GrantDirectRouteMsg = z.infer<typeof GrantDirectRouteMsg>;

export interface GrantDirectRouteResult {
  applied: boolean;
}

// ── Agent → controller: live mesh-state report (Phase 2+) ────────────────────

/**
 * Periodic telemetry the agent PUSHES (no round-trip) from `netbird status
 * --json` / `wg show` / `tailscale status`. Feeds the gateway snapshot store +
 * the controller-side reconcile loop, which updates `MeshPeer`
 * (status/meshIp/lastSeen). Mirrors `serviceState`/`metrics`: telemetry, not a
 * command result.
 *
 * INTEGRATION: add `MeshStateMsg` to the `AgentToControllerMessage` union in
 * `packages/core/src/protocol/messages.ts`.
 */
export const MeshStatePayload = z.object({
  driver: MeshDriverName,
  interface: z.string().optional(),
  meshIp: z.string().optional(),
  peerId: z.string().optional(),
  publicKey: z.string().optional(),
  connected: z.boolean(),
  relayed: z.boolean().default(false),
  /** ISO timestamp of the last WireGuard handshake, if known. */
  lastHandshakeAt: z.string().optional(),
  advertisedRoutes: z.array(z.string()).default([]),
  /** Peers this node currently sees on the mesh (for the peer-map UI). */
  peers: z
    .array(
      z.object({
        peerId: z.string().optional(),
        publicKey: z.string().optional(),
        meshIp: z.string().optional(),
        connected: z.boolean(),
        relayed: z.boolean().default(false),
        lastHandshakeAt: z.string().optional(),
      }),
    )
    .default([]),
  error: z.string().optional(),
  sampledAt: z.number().int(),
});
export type MeshStatePayload = z.infer<typeof MeshStatePayload>;

export const MeshStateMsg = z.object({
  type: z.literal('meshState'),
  payload: MeshStatePayload,
});
export type MeshStateMsg = z.infer<typeof MeshStateMsg>;
