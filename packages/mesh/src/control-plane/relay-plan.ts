/**
 * One relays-on-edges reconcile decision (see `relays.ts`). Pure: planned
 * relays + what the nodes report in, commands + the control-plane relay list out.
 *
 * Ordering rules it encodes (the STUN port is the trap):
 *  - The control-plane node's own relay runs STUN only once NetBird there runs
 *    the external-relay config: until then NetBird's own STUN holds UDP 3478,
 *    and a relay that can't bind its STUN port exits.
 *  - The switch to edge relays waits for one healthy relay; after that the
 *    list follows the planned set (identity, not health), so a flapping edge
 *    never restarts the control plane.
 *  - Switching back lists nothing only together with stopping every relay;
 *    the caller stops them BEFORE NetBird restarts with its own relay + STUN.
 */
import { MeshRelaySpec, meshRelaySpecHash } from '@swarmy/core/protocol';
import { externalRelaysOf, type ExternalRelays, type PlannedRelay } from './relays';

export interface RelayNodeReport {
  nodeId: string;
  running: boolean;
  healthy: boolean;
  specHash?: string;
}

export interface RelayDecisionInput {
  /** relaysOnEdges on, NetBird behind the edge, TLS handed over. */
  wanted: boolean;
  planned: readonly PlannedRelay[];
  controlNodeId: string | null;
  /** What the control-plane config lists now (null = NetBird's own relay). */
  active: ExternalRelays | null;
  /** NetBird on the control node runs the external-relay config (its STUN is off). */
  controlRunsExternal: boolean;
  /** Fresh `meshState.relay` reports. */
  reports: readonly RelayNodeReport[];
  image: string;
  authSecret: string;
}

export interface RelayDecision {
  /** Specs to send (the node's reported spec differs); the caller skips offline nodes. */
  apply: { nodeId: string; spec: MeshRelaySpec }[];
  /** Nodes running a relay that isn't planned. */
  stop: string[];
  /** The relay list the control-plane config should carry. */
  next: ExternalRelays | null;
}

export function relaySpecFor(r: PlannedRelay, input: Pick<RelayDecisionInput, 'controlNodeId' | 'controlRunsExternal' | 'image' | 'authSecret'>): MeshRelaySpec {
  return MeshRelaySpec.parse({
    image: input.image,
    exposedAddress: r.address,
    authSecret: input.authSecret,
    stun: r.nodeId !== input.controlNodeId || input.controlRunsExternal,
  });
}

export function decideRelays(input: RelayDecisionInput): RelayDecision {
  const planned = input.wanted ? input.planned : [];
  const report = new Map(input.reports.map((r) => [r.nodeId, r]));
  const apply = planned
    .map((r) => ({ nodeId: r.nodeId, spec: relaySpecFor(r, input) }))
    .filter((a) => report.get(a.nodeId)?.specHash !== meshRelaySpecHash(a.spec));
  const plannedIds = new Set(planned.map((r) => r.nodeId));
  const stop = input.reports.filter((r) => r.running && !plannedIds.has(r.nodeId)).map((r) => r.nodeId).sort();
  const anyHealthy = planned.some((r) => report.get(r.nodeId)?.healthy);
  const next = input.active || anyHealthy ? externalRelaysOf(planned) : null;
  return { apply, stop, next };
}

/** Same relay list (order-insensitive)? */
export function sameRelays(a: ExternalRelays | null | undefined, b: ExternalRelays | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  const eq = (x: string[], y: string[]) => x.length === y.length && [...x].sort().every((v, i) => v === [...y].sort()[i]);
  return eq(a.addresses, b.addresses) && eq(a.stuns, b.stuns);
}
