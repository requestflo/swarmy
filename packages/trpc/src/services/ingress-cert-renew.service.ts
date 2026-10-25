/**
 * Renew now (board 30): ask the edge Caddy that holds a host's certificate to
 * re-issue it, safely. The agent does the in-task steps (`edge.certRenew`,
 * protocol edge-cert-renew.ts) and puts the old certificate back when no new
 * one comes; this side checks it is allowed (`renewEligibilityFor`: a local
 * certificate store, an ACME certificate that is not a wildcard, agents that
 * know the command, and the per-host rate limit), counts the ask in the audit
 * log BEFORE dispatching, and renders the two Caddyfiles each edge needs.
 *
 * Edges run one after another, and a renew stops at the first that does not
 * get a new certificate: a CA that refused one edge refuses the next, and
 * every refusal spends an ACME failure.
 */
import { TRPCError } from '@trpc/server';
import { EdgeCertRenewResult } from '@swarmy/core/protocol';
import { previewConfig as renderIngress, withoutHost, type IngressConfig } from '@swarmy/ingress';
import type { OrgContext } from '../context';
import { writeAudit } from './audit.service';
import { loadOrgConfig } from './ingress.service';
import { getCertFacts, requireRoutedHost, type CertFactsView } from './ingress-certs.service';
import { forgetEdgeCerts } from './ingress-certs.read';
import { markRenewRequested, recordSeenCert } from './ingress-certs.history';
import { asTheRenew, recordRenewAsk, RENEW_AUDIT_ACTION } from './ingress-cert-renew.limits';

/** How long an edge waits for the CA before putting the old certificate back. */
export const RENEW_WAIT_MS = 120_000;

type EdgeOutcome = 'renewed' | 'restored' | 'no_cert' | 'failed';

export interface RenewCertView {
  host: string;
  /** `renewed`: every edge that held it has a new one · `restored`: none came, the old one is back · `failed`. */
  outcome: 'renewed' | 'restored' | 'failed';
  message: string;
  edges: Array<{ nodeId: string; name: string; outcome: EdgeOutcome; message: string }>;
  /** The facts after the renew (fresh edge reads). */
  facts: CertFactsView;
}

function refuse(why: string, reason: string): TRPCError {
  return new TRPCError({ code: why === 'rate' ? 'TOO_MANY_REQUESTS' : 'PRECONDITION_FAILED', message: reason });
}

export async function renewCertNow(
  ctx: OrgContext,
  rawHost: string,
  deps: { loadConfig: (ctx: OrgContext) => Promise<IngressConfig> } = { loadConfig: loadOrgConfig },
): Promise<RenewCertView> {
  const host = requireRoutedHost(ctx, rawHost);
  const before = await getCertFacts(ctx, host, { fresh: true });
  if (!before.renew.available) throw refuse(before.renew.why, before.renew.reason);
  const holders = before.edges.filter((e) => e.state === 'holds' || e.state === 'other');
  return asTheRenew(ctx.activeOrgId, host, async () => {
    const askedAt = new Date().toISOString();
    await recordRenewAsk(ctx, host, Date.parse(askedAt));
    await writeAudit(ctx, {
      action: RENEW_AUDIT_ACTION,
      targetType: 'domain',
      targetId: host,
      metadata: { host, nodes: holders.map((e) => e.nodeId), serial: before.cert?.serial ?? null, notAfter: before.cert?.notAfter ?? null },
    });
    const config = await deps.loadConfig(ctx);
    const edges: RenewCertView['edges'] = [];
    for (const e of holders) {
      const region = ctx.hub.nodeInfoFor(e.nodeId)?.labels?.['swarmy.region'] || undefined;
      const full = renderIngress({ ...config, enabled: true, localRegion: region }).localReload;
      const without = renderIngress({ ...withoutHost(config, host), enabled: true, localRegion: region }).localReload;
      if (!full?.file || !without?.file) {
        edges.push({ nodeId: e.nodeId, name: e.name, outcome: 'failed', message: 'this front door is not configured in place, so it cannot be renewed here' });
        break;
      }
      try {
        const raw = await ctx.hub.dispatch<unknown>(
          e.nodeId,
          'edge.certRenew',
          { name: host, service: full.service, command: full.command, without: without.file, full: full.file, waitMs: RENEW_WAIT_MS },
          { timeoutMs: RENEW_WAIT_MS + 180_000 },
        );
        const r = EdgeCertRenewResult.parse(raw);
        edges.push({ nodeId: e.nodeId, name: e.name, outcome: r.outcome, message: r.message });
        if (r.outcome === 'renewed' && r.cert) {
          markRenewRequested(ctx.activeOrgId, host, askedAt);
          recordSeenCert(ctx.activeOrgId, host, { notBefore: r.cert.notBefore, notAfter: r.cert.notAfter, serial: r.cert.serial, issuer: r.cert.issuer });
        }
        if (r.outcome !== 'renewed') break;
      } catch (err) {
        edges.push({ nodeId: e.nodeId, name: e.name, outcome: 'failed', message: err instanceof Error ? err.message : String(err) });
        break;
      }
    }
    forgetEdgeCerts(ctx.activeOrgId);
    const all = edges.length === holders.length && edges.every((x) => x.outcome === 'renewed');
    const outcome: RenewCertView['outcome'] = all ? 'renewed' : edges.some((x) => x.outcome === 'restored') ? 'restored' : 'failed';
    const message =
      outcome === 'renewed'
        ? `${host} has a new certificate.`
        : outcome === 'restored'
          ? `No new certificate came, so the previous one is back and still serving ${host}.`
          : `The renew did not finish: ${edges.find((x) => x.outcome === 'failed')?.message ?? 'no edge answered'}.`;
    return { host, outcome, message, edges, facts: await getCertFacts(ctx, host, { fresh: true }) };
  });
}
