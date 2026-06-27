import { z } from 'zod';
import { CommandId } from './primitives';

/**
 * Zero-trust mesh networking protocol (epic #6, MVP — NetBird default,
 * pluggable). Mirrors `ingress.ts`: wire/render types are owned by
 * `@swarmy/core` so the agent and the controller share one definition;
 * `@swarmy/mesh` re-exports them. The controller's mesh driver `render()`s a
 * driver-agnostic {@link RenderedMesh}, carried verbatim to the agent inside
 * `applyMesh`. The agent installs/joins the mesh client; it never reasons about
 * which provider it is — adding a provider is a new driver, never an agent
 * rewrite (generic-intent principle, same as `RenderedConfig`/`applyIngress`).
 *
 * Secrets travel BY REFERENCE: the controller resolves a single-use setup key
 * from the credential vault at dispatch time and injects it just-in-time into
 * `RenderedMesh.client.setupKey` for the one frame that is sent — it is never
 * persisted in plaintext.
 *
 * NOTE FOR THE INTEGRATOR: this file is NEW (allowed by the contract). The
 * `ApplyMeshMsg` must be added to the `ControllerToAgentMessage` union and the
 * result shape to `CommandResultMap` — see INTEGRATION snippets.
 */

/** Wire-level driver name. Mirrors the DB `MeshDriver` enum (lowercased). */
export const MeshDriverName = z.enum(['netbird', 'none']);
export type MeshDriverName = z.infer<typeof MeshDriverName>;

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
 * agent needs to join the mesh. Setup key is single-use + short-TTL and resolved
 * from the vault just-in-time (never persisted in clear).
 */
export const MeshEnrollment = z.object({
  driver: MeshDriverName,
  /** NetBird management server URL (self-hosted or external). */
  managementUrl: z.string().optional(),
  /** Single-use setup key (resolved JIT from the vault, NOT persisted plaintext). */
  setupKey: z.string().optional(),
  /** WireGuard interface name the client will create, e.g. `wt0`. */
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
 * NetBird the agent runs/join the official client container using `client`;
 * for raw-WG-style drivers it would write `files` then run `reloadCommand`.
 */
export const RenderedMesh = z.object({
  driver: MeshDriverName,
  action: z.enum(['join', 'leave', 'reconfigure']).default('join'),
  client: z
    .object({
      kind: z.enum(['netbird', 'none']),
      /** Client container image (pin a digest in prod). */
      image: z.string().optional(),
      managementUrl: z.string().optional(),
      /** Single-use setup key (resolved JIT — only on the dispatched frame). */
      setupKey: z.string().optional(),
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

/** Typed `applyMesh` result for controller-side narrowing (add to CommandResultMap). */
export interface ApplyMeshResult {
  driver: MeshDriverName;
  joined: boolean;
  meshIp?: string;
  peerId?: string;
}
