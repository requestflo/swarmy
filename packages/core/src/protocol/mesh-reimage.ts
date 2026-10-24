import { z } from 'zod';
import { CommandId } from './primitives';
import { MeshImageHint } from './mesh';

/**
 * `reimageMesh` (CommandName `mesh.reimage`): move this node's NetBird client
 * sidecar (`swarmy-netbird`) to another image — the platform upgrade's mesh
 * step, one node at a time (plans/epic-platform-upgrades.md §2.4).
 *
 * Unlike `applyMesh`, which keeps an already-connected client untouched, this
 * replaces the container with the SAME config (env, host network, caps,
 * `/dev/net/tun`, the `swarmy-netbird` state volume — so the peer identity and
 * mesh IP survive) on the new image, and waits for the peer to reconnect. If
 * it doesn't within `reconnectTimeoutMs`, the agent puts the previous
 * container back on its own (it may be reached over that very mesh) and
 * answers failed. No setup key travels: the identity is already on the volume.
 *
 * Additive: gated by the `reimageMesh` agent capability (`capabilities.ts`).
 * Gated by `SWARMY_ALLOW_MESH` like every mesh command (`E_MESH_DISABLED`).
 */
export const ReimageMeshPayload = z.object({
  commandId: CommandId,
  timeoutMs: z.number().int().positive().optional(),
  /** The client image to run (pinned `ref@sha256:…`). */
  image: z.string().min(1),
  /** How long the new client gets to reconnect before the old one is put back. */
  reconnectTimeoutMs: z.number().int().positive().max(10 * 60_000).default(90_000),
  ...MeshImageHint,
});
export type ReimageMeshPayload = z.infer<typeof ReimageMeshPayload>;

export const ReimageMeshMsg = z.object({
  type: z.literal('reimageMesh'),
  payload: ReimageMeshPayload,
});
export type ReimageMeshMsg = z.infer<typeof ReimageMeshMsg>;

export const ReimageMeshResult = z.object({
  /** False: no client on this node, or it already ran that image. */
  changed: z.boolean(),
  /** Why nothing changed (`no-client` / `same-image`). */
  reason: z.enum(['no-client', 'same-image']).optional(),
  /** The image the client ran before. */
  from: z.string().optional(),
  /** The image it runs now (the resolved pull ref). */
  to: z.string().optional(),
  /** The mesh IP after the swap (the same as before: identity persists). */
  meshIp: z.string().optional(),
});
export type ReimageMeshResult = z.infer<typeof ReimageMeshResult>;
