/**
 * `edgeCerts`: the certificates the edge Caddy on THIS node holds, read from
 * its own certificate storage (board 30: issued, covers, which edges hold it).
 *
 * Read-only. The agent runs one shell loop inside this node's running edge
 * task over the docker socket, the way `localReload` and the metrics scrape
 * reach it, that prints only `*.crt` files under Caddy's data directory
 * (`/data/caddy/certificates/<issuer>/<name>/<name>.crt`): never a `.key`,
 * never the `.json` metadata. The agent parses them with node:crypto
 * `X509Certificate` and only the facts below leave the node, never PEM.
 * Caddy's admin API has no certificate listing, so its storage is the
 * cheapest source that says what each edge really holds.
 *
 * A command and not a snapshot field: certificates change every few weeks,
 * so an exec on every metrics tick would be work for nothing. The controller
 * asks while a domain detail is open and keeps the answer for a minute.
 *
 * Gated by the `edgeCerts` agent capability (`capabilities.ts`): an agent
 * that predates it is "not reported", never an error.
 */
import { z } from 'zod';
import { CommandId } from './primitives';

/** Where Caddy keeps certificates inside the edge task (the `/data` volume, both topologies). */
export const EDGE_CERT_DIR = '/data/caddy/certificates';
/** At most this many `.crt` files are read per edge; the rest is reported as `truncated`. */
export const EDGE_CERTS_MAX = 500;

export const EdgeCertsPayload = z.object({
  commandId: CommandId,
  timeoutMs: z.number().int().positive().optional(),
});
export type EdgeCertsPayload = z.infer<typeof EdgeCertsPayload>;

export const EdgeCertsMsg = z.object({
  type: z.literal('edgeCerts'),
  payload: EdgeCertsPayload,
});
export type EdgeCertsMsg = z.infer<typeof EdgeCertsMsg>;

/** One stored certificate's public facts (the leaf of its `.crt`). */
export const EdgeCertFact = z.object({
  /** Caddy's storage name: the host, or `wildcard_.example.com` for `*.example.com`. */
  name: z.string().min(1),
  /** The issuer's storage directory (`acme-v02.api.letsencrypt.org-directory`, `local`, ...). */
  issuerKey: z.string().min(1),
  /** The issuing CA as "<O> <CN>", e.g. "Let's Encrypt R11"; null when the cert names none. */
  issuer: z.string().nullable(),
  /** ISO-8601 UTC: issued at (notBefore) and expires at (notAfter). */
  notBefore: z.string(),
  notAfter: z.string(),
  /** DNS names the certificate covers (subjectAltName), lower-cased, `*.` kept. */
  names: z.array(z.string()),
  serial: z.string(),
  /** SHA-256 of the leaf (colon hex): tells two edges' copies apart. */
  fingerprint256: z.string(),
});
export type EdgeCertFact = z.infer<typeof EdgeCertFact>;

export const EdgeCertsResult = z.object({
  /** False when no edge Caddy task runs on this node (nothing to read). */
  edge: z.boolean(),
  certs: z.array(EdgeCertFact).default([]),
  /** More `.crt` files than {@link EDGE_CERTS_MAX}: the list is partial. */
  truncated: z.boolean().default(false),
  /** When the agent read the storage (its clock, ISO-8601 UTC). */
  checkedAt: z.string(),
});
export type EdgeCertsResult = z.infer<typeof EdgeCertsResult>;
