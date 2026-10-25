import { z } from 'zod';
import { orgProcedure } from '../trpc';
import { abacProcedure } from '../abac';
import { getCertFacts } from '../services/ingress-certs.service';
import { renewCertNow } from '../services/ingress-cert-renew.service';
import { resolveDomainHost } from './ingress-host-resolver';

/**
 * A routed host's certificate as the edges hold it (board 30, Domain detail).
 * Spread into the ingress router.
 */
const HostInput = z.object({ host: z.string().min(1).max(253) });

export const ingressCertProcedures = {
  /**
   * Issuer, issued, expiry, the names covered, which edges hold it, when it
   * renews and the renewals seen — read from each edge's own Caddy storage
   * (`.crt` facts only). Edges whose agent predates the read are "not
   * reported", never an error. `renew` says whether Renew now is offered.
   */
  certFacts: orgProcedure.input(HostInput).query(({ ctx, input }) => getCertFacts(ctx, input.host)),

  /**
   * Renew now: the edge re-issues the host's certificate, the old one put back
   * when no new one comes. An ingress write like the others (ABAC
   * `ingress.write`, judged by the routed service), audited as
   * `ingress.renewCert` before dispatch, and rate-limited per host (once an
   * hour, three a week) so it can never burn the Let's Encrypt limits.
   */
  renewCert: abacProcedure('ingress.write', resolveDomainHost)
    .input(HostInput)
    .mutation(({ ctx, input }) => renewCertNow(ctx, input.host)),
};
