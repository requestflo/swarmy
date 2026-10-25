import type { EdgeCertFact } from '@swarmy/core/protocol';

/**
 * Which stored certificate serves a host, and which edges hold it (board 30:
 * issuer, issued, covers, served by). Pure over what each edge's agent read
 * from its own Caddy storage (`edgeCerts`); the controller does the IO.
 *
 * Caddy's handshake picks an exact-name certificate before a wildcard one
 * (certmagic `getCertificate`), and the newest when several match, so the
 * pick here follows the same order: exact first, then latest notAfter.
 */

/** One edge's answer: read, not reported (an agent that predates `edgeCerts`), or failed. */
export type EdgeCertRead =
  | { nodeId: string; status: 'read'; certs: EdgeCertFact[]; checkedAt: string }
  | { nodeId: string; status: 'not_reported'; reason: string }
  | { nodeId: string; status: 'error'; reason: string };

export type EdgeHoldState = 'holds' | 'other' | 'missing' | 'not_reported' | 'error';

export interface HostCertFacts {
  host: string;
  /** The certificate the edges serve for it, null when no edge reported one. */
  cert: (EdgeCertFact & { wildcard: string | null }) | null;
  /** Per edge: holds that certificate, holds a different one (an older copy not synced yet), holds none, or could not say. */
  edges: Array<{ nodeId: string; state: EdgeHoldState; reason?: string }>;
  /** Edges that answered (read), out of `edges.length`. */
  reported: number;
}

/** Does a certificate name cover `host`? Exactly, or as `*.parent` one label up (RFC 6125 §6.4.3). */
export function nameCovers(name: string, host: string): boolean {
  const n = name.toLowerCase().replace(/\.$/, '');
  const h = host.toLowerCase().replace(/\.$/, '');
  if (n === h) return true;
  if (!n.startsWith('*.')) return false;
  const dot = h.indexOf('.');
  return dot > 0 && h.slice(dot + 1) === n.slice(2);
}

/** The wildcard name that covers `host` on this certificate, or null when an exact name does. */
function wildcardFor(cert: EdgeCertFact, host: string): string | null {
  if (cert.names.some((n) => n.toLowerCase() === host.toLowerCase())) return null;
  return cert.names.find((n) => n.startsWith('*.') && nameCovers(n, host)) ?? null;
}

/** Caddy's order: exact before wildcard, then the latest expiry. */
function better(a: EdgeCertFact, b: EdgeCertFact, host: string): boolean {
  const aw = wildcardFor(a, host) !== null;
  const bw = wildcardFor(b, host) !== null;
  if (aw !== bw) return !aw;
  return a.notAfter > b.notAfter;
}

function pick(certs: EdgeCertFact[], host: string): EdgeCertFact | null {
  let best: EdgeCertFact | null = null;
  for (const c of certs) {
    if (c.names.some((n) => nameCovers(n, host)) && (!best || better(c, best, host))) best = c;
  }
  return best;
}

/** Fold every edge's read into the host's certificate and who holds it. */
export function hostCertFacts(host: string, reads: readonly EdgeCertRead[]): HostCertFacts {
  const perEdge = reads.map((r) => ({ r, best: r.status === 'read' ? pick(r.certs, host) : null }));
  let chosen: EdgeCertFact | null = null;
  for (const { best } of perEdge) if (best && (!chosen || better(best, chosen, host))) chosen = best;
  const edges = perEdge.map(({ r, best }): HostCertFacts['edges'][number] => {
    if (r.status !== 'read') return { nodeId: r.nodeId, state: r.status, reason: r.reason };
    if (!best) return { nodeId: r.nodeId, state: 'missing' };
    return { nodeId: r.nodeId, state: chosen && best.fingerprint256 === chosen.fingerprint256 ? 'holds' : 'other' };
  });
  return {
    host,
    cert: chosen ? { ...chosen, wildcard: wildcardFor(chosen, host) } : null,
    edges,
    reported: reads.filter((r) => r.status === 'read').length,
  };
}
