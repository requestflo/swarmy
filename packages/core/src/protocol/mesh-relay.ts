import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CommandId } from './primitives';

/**
 * Relays on edges (plans/epic-self-hosted-mesh-and-fleets.md §2.5 "Two cheap
 * HA wins", M3): `swarmy-mesh-relay`, NetBird's standalone relay (+ STUN) on
 * an edge node's host network, supervised by that node's agent like
 * `swarmy-mesh-control`. Peers dial it as `rels://relay.<a-b-c-d>.<base>:443`
 * through the edge Caddy (which proxies to `<mesh IP>:listenPort`), so relayed
 * pairs keep working when the control-plane node is gone, and relay bandwidth
 * spreads over the edges.
 *
 * The shared secret rides this frame only: the agent writes it into the
 * container's tmpfs (never the image, the container spec or `docker inspect`)
 * and keeps a 0600 copy in its own state dir for restarts.
 */
export const MeshRelaySpec = z.object({
  image: z.string().min(1),
  /** What peers dial and what the relay announces (`rels://host:443`). */
  exposedAddress: z.string().regex(/^rels?:\/\/[^\s'"\\]+$/),
  /** Plain WebSocket listener behind the edge (every interface; firewalled). */
  listenPort: z.number().int().min(1).max(65535).default(33080),
  /**
   * Health on loopback and Prometheus (every interface; firewalled): next to
   * the listener, off the control plane's 9000/9090 and off the 9001/9091 that
   * Portainer agents, MinIO consoles and pushgateways tend to hold.
   */
  healthPort: z.number().int().min(1).max(65535).default(33081),
  metricsPort: z.number().int().min(1).max(65535).default(33082),
  /**
   * Embedded STUN on UDP `stunPort`. Off on the control-plane node until its
   * NetBird runs with external relays (its own STUN holds the port till then).
   */
  stun: z.boolean().default(true),
  stunPort: z.number().int().min(1).max(65535).default(3478),
  /** The relay shared secret: management's `authSecret` (vault). */
  authSecret: z.string().min(16).regex(/^[^\n\r\0]+$/),
});
export type MeshRelaySpec = z.infer<typeof MeshRelaySpec>;

/** Deterministic hash of a spec (both sides compute it: the drift check). */
export function meshRelaySpecHash(spec: MeshRelaySpec): string {
  const s = MeshRelaySpec.parse(spec);
  const canonical = Object.fromEntries(Object.entries(s).sort(([a], [b]) => (a < b ? -1 : 1)));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export const ApplyMeshRelayPayload = z.object({
  commandId: CommandId,
  timeoutMs: z.number().int().positive().optional(),
  /** apply = converge to `spec`; stop = remove + forget the local copy; status = report only. */
  action: z.enum(['apply', 'stop', 'status']).default('apply'),
  spec: MeshRelaySpec.optional(),
});
export type ApplyMeshRelayPayload = z.infer<typeof ApplyMeshRelayPayload>;

export const ApplyMeshRelayMsg = z.object({
  type: z.literal('applyMeshRelay'),
  payload: ApplyMeshRelayPayload,
});
export type ApplyMeshRelayMsg = z.infer<typeof ApplyMeshRelayMsg>;

/** The relay's live status on its node (command result + `meshState.relay`). */
export const MeshRelayStatus = z.object({
  running: z.boolean(),
  /** The WebSocket listener accepts connections (its /health is a TLS check: 503 behind the edge). */
  healthy: z.boolean(),
  exposedAddress: z.string().optional(),
  /** {@link meshRelaySpecHash} of the spec it runs. */
  specHash: z.string().optional(),
  stun: z.boolean().optional(),
  error: z.string().optional(),
});
export type MeshRelayStatus = z.infer<typeof MeshRelayStatus>;
