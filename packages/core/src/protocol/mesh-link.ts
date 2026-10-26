import { z } from 'zod';

/**
 * What one node says about its link to one peer, carried per peer in
 * `meshState.peers[].link` (additive: older agents leave it out, and the
 * dashboard says "not reported"). Read from the mesh client's own status by
 * the pure parsers in `@swarmy/mesh` (`link-facts.ts`). Every field is
 * optional because absent means unknown, never zero: Headscale's client
 * measures no latency, and a peer that isn't connected has no facts at all.
 */
export const MeshLinkFacts = z.object({
  /** Round trip in ms, as the client measured it (NetBird). */
  latencyMs: z.number().finite().nonnegative().optional(),
  /** true = through a relay (still end-to-end encrypted), false = peer to peer. */
  relayed: z.boolean().optional(),
  /** Bytes received from / sent to this peer since the tunnel came up. */
  rxBytes: z.number().int().nonnegative().optional(),
  txBytes: z.number().int().nonnegative().optional(),
});
export type MeshLinkFacts = z.infer<typeof MeshLinkFacts>;

/** One direction of a link, as the controller serves it (`mesh.links`); null = not reported. */
export interface MeshLinkEndView {
  latencyMs: number | null;
  relayed: boolean | null;
  rxBytes: number | null;
  txBytes: number | null;
  /** When the reporting agent sampled it (ISO). */
  at: string;
}

/**
 * A link between two servers. `a`/`b` are node ids (a < b); `ab` is what `a`
 * reports about its link to `b`, `ba` the reverse. The two can differ (each
 * end measures its own round trip), so both are kept; null = that end's
 * agent didn't report it (an older agent, or it doesn't see the peer).
 */
export interface MeshLinkView {
  a: string;
  b: string;
  ab: MeshLinkEndView | null;
  ba: MeshLinkEndView | null;
}
