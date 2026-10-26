import type { DemoStore, DomainResolvers } from '../types';

/**
 * `mesh.links` (mirror of `MeshLinkView`, mesh-links.service.ts) for the
 * mesh map, the estate map and Add a server (boards 14, 22, 12). Derived from
 * the demo's live peers, so a server that joins (phone-home.ts) gets links:
 * the managers sit side by side (0.6 ms), wkr-1 is behind a strict NAT and
 * reaches them through the relay (~19 ms), and a newcomer in the same house
 * links straight to wkr-1 (0.4 ms) and punches through to the managers
 * (11-12 ms). mgr-2 reports nothing about wkr-1, so that end reads "not
 * reported", as an older agent's would.
 */

interface End {
  latencyMs: number | null;
  relayed: boolean | null;
  rxBytes: number | null;
  txBytes: number | null;
  at: string;
}
interface Link {
  a: string;
  b: string;
  ab: End | null;
  ba: End | null;
}
interface PeerLike {
  nodeId: string;
  status: string;
}

const MB = 1024 ** 2;
const GB = 1024 ** 3;

/** [a → b, b → a] for the seeded pairs (a < b); null = that end didn't report. */
type Spec = [Omit<End, 'at'> | null, Omit<End, 'at'> | null];
const SEEDED: Record<string, Spec> = {
  'n-mgr-1~n-mgr-2': [
    { latencyMs: 0.6, relayed: false, rxBytes: Math.round(1.9 * GB), txBytes: Math.round(2.3 * GB) },
    { latencyMs: 0.7, relayed: false, rxBytes: Math.round(2.3 * GB), txBytes: Math.round(1.9 * GB) },
  ],
  'n-mgr-1~n-wkr-1': [
    { latencyMs: 19.4, relayed: true, rxBytes: 412 * MB, txBytes: 96 * MB },
    { latencyMs: 18.9, relayed: true, rxBytes: 96 * MB, txBytes: 412 * MB },
  ],
  'n-mgr-2~n-wkr-1': [null, { latencyMs: 21.2, relayed: true, rxBytes: 38 * MB, txBytes: 140 * MB }],
};

const SEEDED_IDS = new Set(['n-mgr-1', 'n-mgr-2', 'n-wkr-1', 'n-wkr-2', 'n-wkr-3']);

/** A newcomer (Add a server) links straight to wkr-1 in the same house and punches through to the rest. */
function newcomerSpec(newcomer: string, other: string): Spec {
  const ms = other === 'n-wkr-1' ? 0.4 : !SEEDED_IDS.has(other) ? 0.3 : other === 'n-mgr-1' ? 11 : 12;
  const at = (v: number): Omit<End, 'at'> => ({ latencyMs: v, relayed: false, rxBytes: 3 * MB, txBytes: 2 * MB });
  return [at(ms), at(Math.round(ms * 1.06 * 10) / 10)];
}

export function demoMeshLinks(peers: readonly PeerLike[], now = new Date()): Link[] {
  const at = now.toISOString();
  const on = peers.filter((p) => p.status === 'CONNECTED').map((p) => p.nodeId).sort();
  const out: Link[] = [];
  for (let i = 0; i < on.length; i++) {
    for (let j = i + 1; j < on.length; j++) {
      const [a, b] = [on[i]!, on[j]!];
      const fresh = !SEEDED_IDS.has(a) ? newcomerSpec(a, b) : !SEEDED_IDS.has(b) ? (newcomerSpec(b, a).reverse() as Spec) : null;
      const spec = SEEDED[`${a}~${b}`] ?? fresh;
      if (!spec) continue;
      out.push({ a, b, ab: spec[0] ? { ...spec[0], at } : null, ba: spec[1] ? { ...spec[1], at } : null });
    }
  }
  return out;
}

export const meshLinks: DomainResolvers = {
  handlers: {
    'mesh.links': (_i, store: DemoStore): Link[] => {
      const mesh = store.extra.mesh as { enabled: boolean; peers: PeerLike[] } | undefined;
      return mesh?.enabled ? demoMeshLinks(mesh.peers) : [];
    },
  },
};
