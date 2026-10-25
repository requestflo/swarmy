/**
 * A routed host's certificate as the edges hold it (board 30, Domain
 * detail): issuer, issued (notBefore), expiry, the names it covers (and the
 * wildcard, when one covers it) and which edges hold it. Facts come from each
 * edge's own Caddy storage (`ingress-certs.read.ts`); the pure fold is
 * `@swarmy/ingress` `hostCertFacts`; when Caddy will renew it and the
 * renewals seen are `renewalWindow` / `noteCert`. The controller's TLS probe
 * (`ingress.domainStatus`) stays the view of what the public is served.
 */
import {
  companionHost,
  hostCertFacts,
  normalizeHostname,
  renewalWindow,
  type EdgeHoldState,
  type RenewalSeen,
  type RenewalWindow,
} from '@swarmy/ingress';
import type { OrgContext } from '../context';
import { notFound } from '../errors';
import { listRoutesForOrg } from './ingress-routes';
import { readEdgeCertsAll } from './ingress-certs.read';
import { certHistory, recordSeenCert } from './ingress-certs.history';

export interface CertFactsView {
  host: string;
  /** `edges`: read from the edges' storage · `not_reported`: no edge can say yet · `no_edges`: no edge task runs. */
  source: 'edges' | 'not_reported' | 'no_edges';
  /** Plain words for why there are no facts (null when there are). */
  reason: string | null;
  cert: {
    issuer: string | null;
    issuerKey: string;
    notBefore: string;
    notAfter: string;
    /** Every name the certificate covers. */
    names: string[];
    /** The `*.` name that covers this host, when the certificate is a wildcard one. */
    wildcard: string | null;
    serial: string;
  } | null;
  edges: Array<{ nodeId: string; name: string; state: EdgeHoldState; reason: string | null }>;
  /** When Caddy will renew it (a third of the lifetime left; the CA may suggest otherwise), null without a cert. */
  renewal: RenewalWindow | null;
  /** Renewals this controller saw (a newer notBefore than an earlier read), newest first; empty when none. */
  renewals: RenewalSeen[];
  /** The newest edge read time (ISO), null when no edge answered. */
  checkedAt: string | null;
}

/** A routed host (or its www companion), normalised; NOT_FOUND otherwise. */
export function requireRoutedHost(ctx: OrgContext, raw: string): string {
  const host = normalizeHostname(raw);
  const routed = listRoutesForOrg(ctx).some((r) => {
    const h = normalizeHostname(r.route.host);
    return h === host || (Boolean(r.route.www) && companionHost(h) === host);
  });
  if (!routed) throw notFound('domain', host);
  return host;
}

export async function getCertFacts(ctx: OrgContext, rawHost: string, opts: { fresh?: boolean } = {}): Promise<CertFactsView> {
  const host = requireRoutedHost(ctx, rawHost);
  const reads = await readEdgeCertsAll(ctx, opts);
  const facts = hostCertFacts(host, reads);
  const rows = reads.length
    ? await ctx.db.node.findMany({ where: { orgId: ctx.activeOrgId }, select: { id: true, name: true } })
    : [];
  const nameOf = new Map(rows.map((n) => [n.id, n.name]));
  const checked = reads.flatMap((r) => (r.status === 'read' ? [r.checkedAt] : [])).sort();
  const unread = reads.flatMap((r) => (r.status === 'read' ? [] : [r.reason]));
  const source: CertFactsView['source'] = reads.length === 0 ? 'no_edges' : facts.reported === 0 ? 'not_reported' : 'edges';
  const c = facts.cert;
  const history = c
    ? recordSeenCert(ctx.activeOrgId, host, { notBefore: c.notBefore, notAfter: c.notAfter, serial: c.serial, issuer: c.issuer })
    : certHistory(ctx.activeOrgId, host);
  return {
    host,
    source,
    reason:
      source === 'no_edges'
        ? 'No front door is running, so no edge holds a certificate.'
        : source === 'not_reported'
          ? `Not reported: ${unread[0] ?? 'no edge answered'}.`
          : null,
    cert: c
      ? { issuer: c.issuer, issuerKey: c.issuerKey, notBefore: c.notBefore, notAfter: c.notAfter, names: c.names, wildcard: c.wildcard, serial: c.serial }
      : null,
    edges: facts.edges.map((e) => ({ nodeId: e.nodeId, name: nameOf.get(e.nodeId) ?? e.nodeId, state: e.state, reason: e.reason ?? null })),
    renewal: c ? renewalWindow(c.notBefore, c.notAfter) : null,
    renewals: history.renewals,
    checkedAt: checked.at(-1) ?? null,
  };
}
