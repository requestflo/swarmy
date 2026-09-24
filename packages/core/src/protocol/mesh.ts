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
      /**
       * Extra CA (PEM) the client trusts on top of its system roots, for a
       * control plane behind a private CA. Not a secret.
       */
      caPem: z.string().optional(),
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
  /**
   * The self-hosted control plane, when THIS node runs it (swarmy-mesh-control).
   * Declared lazily: MeshControlStatus is defined further down.
   */
  control: z.lazy(() => MeshControlStatus).optional(),
  sampledAt: z.number().int(),
});
export type MeshStatePayload = z.infer<typeof MeshStatePayload>;

export const MeshStateMsg = z.object({
  type: z.literal('meshState'),
  payload: MeshStatePayload,
});
export type MeshStateMsg = z.infer<typeof MeshStateMsg>;

// ── Self-hosted control plane (plans/epic-self-hosted-mesh-and-fleets.md M1) ──

/**
 * The Litestream sidecar that ships the control plane's SQLite files to Garage
 * (`swarmy-mesh-litestream`). Its config holds no credentials; the key rides
 * `env` (LITESTREAM_ACCESS_KEY_ID / LITESTREAM_SECRET_ACCESS_KEY).
 */
export const MeshControlLitestream = z.object({
  image: z.string(),
  configYaml: z.string(),
  env: z.record(z.string()).default({}),
  /** Overlay the sidecar attaches to so it reaches Garage (`swarmy`). */
  network: z.string().default('swarmy'),
});
export type MeshControlLitestream = z.infer<typeof MeshControlLitestream>;

/**
 * What the agent runs as `swarmy-mesh-control`: the combined NetBird server on
 * the host network, NOT a swarm service (the swarm depends on the mesh, so the
 * mesh must not depend on the swarm). `configYaml` carries the vault secrets
 * (authSecret, encryptionKey); the agent writes it into the container's tmpfs
 * and keeps a 0600 copy in its own state dir for cold boots (spike §11.1).
 */
export const MeshControlSpec = z.object({
  image: z.string(),
  configYaml: z.string(),
  /** Non-secret env (NB_DISABLE_GEOLOCATION, GOMEMLIMIT). */
  env: z.record(z.string()).default({}),
  /**
   * Extra CA certificate(s), PEM, that NetBird trusts on top of the system
   * roots — for a swarmy (the IdP issuer) behind a private CA. NetBird only
   * accepts an https issuer, so a lab or an intranet needs this.
   */
  caPem: z.string().optional(),
  litestream: MeshControlLitestream.nullable().default(null),
});
export type MeshControlSpec = z.infer<typeof MeshControlSpec>;

export const ApplyMeshControlPayload = z.object({
  commandId: CommandId,
  timeoutMs: z.number().int().positive().optional(),
  /**
   * apply = converge to `spec` (restart only when the config or image changed);
   * restore = `litestream restore` the replica into an EMPTY volume first, then
   * apply (moving the control plane to this node); stop = fence (stop + forget
   * the local copy); status = report only.
   */
  action: z.enum(['apply', 'restore', 'stop', 'status']).default('apply'),
  spec: MeshControlSpec.optional(),
});
export type ApplyMeshControlPayload = z.infer<typeof ApplyMeshControlPayload>;

export const ApplyMeshControlMsg = z.object({
  type: z.literal('applyMeshControl'),
  payload: ApplyMeshControlPayload,
});
export type ApplyMeshControlMsg = z.infer<typeof ApplyMeshControlMsg>;

/** Live control-plane status on the node that hosts it (result + meshState). */
export const MeshControlStatus = z.object({
  running: z.boolean(),
  /** `:9000/health` answered 200. */
  healthy: z.boolean(),
  image: z.string().optional(),
  /** sha256 of the config the server is running with. */
  configHash: z.string().optional(),
  /** The server is up but waiting for its config (tmpfs empty after a restart). */
  waitingForConfig: z.boolean().default(false),
  startedAt: z.string().optional(),
  litestream: z
    .object({ running: z.boolean(), lastError: z.string().optional() })
    .optional(),
  restored: z.boolean().optional(),
  error: z.string().optional(),
});
export type MeshControlStatus = z.infer<typeof MeshControlStatus>;

// ── People access routers (plan §3.3) ─────────────────────────────────────────

/**
 * `swarmy-access-<stackId>`: a NetBird client attached ONLY to one stack's
 * overlay, enrolled into `swarmy:<c>:router:<stackId>`, acting as the routing
 * peer of the stack's NetBird Network. It also resolves the stack's service
 * VIPs through Docker DNS on that overlay (VIPs are read live, never stored).
 */
export const ApplyAccessRouterPayload = z.object({
  commandId: CommandId,
  timeoutMs: z.number().int().positive().optional(),
  action: z.enum(['up', 'down', 'resolve']).default('up'),
  stackId: z.string(),
  /** The stack overlay (must be attachable). */
  network: z.string(),
  image: z.string().optional(),
  managementUrl: z.string().optional(),
  /** Single-use key (only on first create; the peer identity lives on its volume). */
  setupKey: z.string().optional(),
  /** Service DNS names on the overlay to resolve to VIPs (`storefront_db`). */
  resolve: z.array(z.string()).default([]),
  /** Extra CA (PEM) for a control plane behind a private CA. */
  caPem: z.string().optional(),
});
export type ApplyAccessRouterPayload = z.infer<typeof ApplyAccessRouterPayload>;

export const ApplyAccessRouterMsg = z.object({
  type: z.literal('applyAccessRouter'),
  payload: ApplyAccessRouterPayload,
});
export type ApplyAccessRouterMsg = z.infer<typeof ApplyAccessRouterMsg>;

export interface ApplyAccessRouterResult {
  running: boolean;
  /** The router has a mesh IP (enrolled + connected to management). */
  connected: boolean;
  meshIp?: string;
  /** name → VIP for each requested service that resolved. */
  vips: Record<string, string>;
  /** Set when the overlay refused a container (not attachable). */
  error?: string;
}
