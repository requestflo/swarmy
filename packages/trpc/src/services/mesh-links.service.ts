/**
 * Mesh link latency and bytes (boards 12, 14, 22). Each agent's 20 s
 * `meshState` lists the peers it sees, and a newer agent adds each one's link
 * facts (`peers[].link`: latency, path, bytes; additive). The latest report
 * per node is held here, process-local, like the live peer map (telemetry,
 * never stored), and `mesh.links` pairs them up by node: a peer's mesh IP is
 * resolved to a server through the org's live peers. Both directions are
 * kept, because each end measures its own round trip.
 */
import type { MeshLinkEndView, MeshLinkFacts, MeshLinkView } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { meshPeers } from './mesh-peers';

export interface MeshLinkReport {
  at: number;
  /** Peer mesh IP → what this node says about its link to it. */
  links: Map<string, MeshLinkFacts>;
}

/** A report counts for two minutes (six `meshState` ticks), like the MTU check's. */
const FRESH_MS = 120_000;

export class MeshLinkLiveStore {
  private readonly byOrg = new Map<string, Map<string, MeshLinkReport>>();

  /**
   * Fold one `meshState`'s peers. Each report replaces the node's last one, so
   * a peer that went away stops showing. An older agent sends no `link`, so
   * its report holds nothing and the dashboard says "not reported".
   */
  report(
    orgId: string,
    nodeId: string,
    peers: readonly { meshIp?: string; link?: MeshLinkFacts }[],
    at = Date.now(),
  ): void {
    const links = new Map<string, MeshLinkFacts>();
    for (const p of peers) if (p.meshIp && p.link) links.set(p.meshIp, p.link);
    const m = this.byOrg.get(orgId) ?? new Map<string, MeshLinkReport>();
    m.set(nodeId, { at, links });
    this.byOrg.set(orgId, m);
  }

  fresh(orgId: string, now = Date.now()): Map<string, MeshLinkReport> {
    return new Map([...(this.byOrg.get(orgId) ?? new Map<string, MeshLinkReport>())].filter(([, r]) => now - r.at <= FRESH_MS));
  }

  clear(): void {
    this.byOrg.clear();
  }
}

export const meshLinksLive = new MeshLinkLiveStore();

const end = (f: MeshLinkFacts, at: number): MeshLinkEndView => ({
  latencyMs: f.latencyMs ?? null,
  relayed: f.relayed ?? null,
  rxBytes: f.rxBytes ?? null,
  txBytes: f.txBytes ?? null,
  at: new Date(at).toISOString(),
});

/**
 * Pure: every node's report → one row per pair of servers, with each end's
 * view. A peer IP that isn't one of the org's servers (a laptop, an access
 * router, a server that left) and a node's own IP are skipped.
 */
export function pairMeshLinks(reports: ReadonlyMap<string, MeshLinkReport>, nodeOfIp: ReadonlyMap<string, string>): MeshLinkView[] {
  const pairs = new Map<string, MeshLinkView>();
  for (const [from, r] of reports) {
    for (const [ip, facts] of r.links) {
      const to = nodeOfIp.get(ip);
      if (!to || to === from) continue;
      const [a, b] = from < to ? [from, to] : [to, from];
      const key = `${a}~${b}`;
      const row = pairs.get(key) ?? { a, b, ab: null, ba: null };
      if (from === a) row.ab = end(facts, r.at);
      else row.ba = end(facts, r.at);
      pairs.set(key, row);
    }
  }
  return [...pairs.values()].sort((x, y) => (x.a === y.a ? (x.b < y.b ? -1 : 1) : x.a < y.a ? -1 : 1));
}

/** `mesh.links`: the org's server-to-server links that some end reported. */
export function getMeshLinks(ctx: OrgContext, now = Date.now()): MeshLinkView[] {
  const nodeOfIp = new Map<string, string>();
  for (const p of meshPeers.forOrg(ctx.activeOrgId)) if (p.meshIp) nodeOfIp.set(p.meshIp, p.nodeId);
  return pairMeshLinks(meshLinksLive.fresh(ctx.activeOrgId, now), nodeOfIp);
}
