/**
 * `edgeCertRenew`: have this node's edge Caddy re-issue one certificate now
 * (board 30, Renew now). Caddy's admin API has no renew endpoint, and a
 * reload alone changes nothing (a managed certificate stays in Caddy's
 * in-memory cache), so the agent does it in four safe steps inside the task:
 *
 *  1. write + reload `without` (this node's render with the host left out):
 *     Caddy stops managing the host and drops its certificate from memory;
 *  2. move the host's stored certificate aside (same volume, not deleted);
 *  3. write + reload `full` (the current render): Caddy finds no stored
 *     certificate and orders a new one from the CA;
 *  4. wait up to `waitMs` for a new `.crt`. If one lands, the moved-aside copy
 *     is deleted. If none does (CAA, DNS, the CA's limits), the old one is put
 *     back and Caddy reloaded so it serves it again, never left without one.
 *
 * Only for a node-local certificate store: with the shared store every edge
 * would pull the old copy back from the replica, so the controller refuses.
 * Gated by the `edgeCertRenew` agent capability (`capabilities.ts`).
 */
import { z } from 'zod';
import { CommandId } from './primitives';
import { EdgeCertFact } from './edge-certs';

/** A host as Caddy names its stored certificate: lower-case DNS labels, no wildcard, nothing a shell would expand. */
export const CertStorageName = z
  .string()
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/, 'a lower-case host name');

const InTaskFile = z.object({ path: z.string().startsWith('/'), contents: z.string() });

export const EdgeCertRenewPayload = z.object({
  commandId: CommandId,
  timeoutMs: z.number().int().positive().optional(),
  /** The certificate to re-issue: Caddy's storage name, i.e. the host. */
  name: CertStorageName,
  /** The edge service whose local task holds it, and its reload command (the render's `localReload`). */
  service: z.string().min(1),
  command: z.array(z.string()).min(1),
  /** This node's render without the host, then the full render. */
  without: InTaskFile,
  full: InTaskFile,
  /** How long to wait for the new certificate before putting the old one back. */
  waitMs: z.number().int().min(10_000).max(300_000).default(120_000),
});
export type EdgeCertRenewPayload = z.infer<typeof EdgeCertRenewPayload>;

export const EdgeCertRenewMsg = z.object({
  type: z.literal('edgeCertRenew'),
  payload: EdgeCertRenewPayload,
});
export type EdgeCertRenewMsg = z.infer<typeof EdgeCertRenewMsg>;

export const EdgeCertRenewResult = z.object({
  /** `renewed`: a new certificate is stored and served · `restored`: none came, the old one is back · `no_cert`: this edge held none. */
  outcome: z.enum(['renewed', 'restored', 'no_cert']),
  /** What the edge holds now (the new one, or the old one put back). */
  cert: EdgeCertFact.nullable(),
  /** What it held before. */
  previous: EdgeCertFact.nullable(),
  message: z.string(),
  tookMs: z.number().int().nonnegative(),
});
export type EdgeCertRenewResult = z.infer<typeof EdgeCertRenewResult>;
