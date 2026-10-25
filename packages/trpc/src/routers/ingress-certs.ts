import { z } from 'zod';
import { orgProcedure } from '../trpc';
import { getCertFacts } from '../services/ingress-certs.service';

/**
 * A routed host's certificate as the edges hold it (board 30, Domain detail).
 * Spread into the ingress router.
 */
const HostInput = z.object({ host: z.string().min(1).max(253) });

export const ingressCertProcedures = {
  /**
   * Issuer, issued, expiry, the names covered and which edges hold it — read
   * from each edge's own Caddy storage (`.crt` facts only). Edges whose agent
   * predates the read are "not reported", never an error.
   */
  certFacts: orgProcedure.input(HostInput).query(({ ctx, input }) => getCertFacts(ctx, input.host)),
};
