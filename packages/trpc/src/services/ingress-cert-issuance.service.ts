/**
 * Edge settings' issuance count (board 31): the certificates every edge
 * holds and how many were issued each day, read from each edge's own Caddy
 * storage (`ingress-certs.read.ts`, kept a minute; `.crt` facts only) and
 * folded by `@swarmy/ingress` `certIssuance`. "Live" (a TLS handshake per
 * host, `ingress.listDomains`) stays the view of what the public is served;
 * this is what the edges were issued.
 */
import { certIssuance, type CertIssuance } from '@swarmy/ingress';
import type { OrgContext } from '../context';
import { readEdgeCertsAll } from './ingress-certs.read';

export interface CertIssuanceView extends CertIssuance {
  /** `edges`: read from the edges' storage · `not_reported`: no edge can say yet · `no_edges`: no edge task runs. */
  source: 'edges' | 'not_reported' | 'no_edges';
}

export async function getCertIssuance(ctx: OrgContext, now = Date.now()): Promise<CertIssuanceView> {
  const reads = await readEdgeCertsAll(ctx);
  const facts = certIssuance(reads, now);
  return { ...facts, source: reads.length === 0 ? 'no_edges' : facts.reported === 0 ? 'not_reported' : 'edges' };
}
