import { z } from 'zod';
import { CommandId } from './primitives';

/**
 * Authoritative geo-DNS protocol ("swarmy is the nameserver" —
 * docs/product/edge-network.md). Mirrors `ingress.ts`/`mesh.ts`: wire types are
 * owned by `@swarmy/core` so the agent, the controller, and the swarmy-dns
 * server share one definition; `@swarmy/dns` re-exports them.
 *
 * The controller composes a {@link DnsSnapshotBundle} (every zone the org
 * hosts, fully derived: geo records from ingress truth + manual static
 * records) and dispatches `applyDns` to each ingress+outlet node. The agent
 * delivers the bundle to the node-local swarmy-dns admin API
 * (`http://127.0.0.1:53535/v1/snapshot`) — a PUSH, never a Docker config
 * rotation, so zone/health changes never restart the DNS data plane. swarmy-dns
 * persists the bundle and keeps answering through controller outages.
 *
 * Versioning: `DnsSnapshotBundle.version` is monotonic per org; swarmy-dns
 * rejects stale pushes so out-of-order delivery is harmless. Zone SOA serials
 * bump only when composed content changes (see `bundleSignature` in
 * `@swarmy/dns`).
 *
 * The admin bearer token travels JIT on the dispatched frame only (mesh
 * setup-key rule): derived controller-side as
 * `HMAC(SWARMY_SECRET_KEY, 'dns-admin:' + orgId)`, never persisted.
 */

/** Manual record types swarmy hosts beyond the derived geo A/AAAA records. */
export const DnsRecordType = z.enum([
  'A',
  'AAAA',
  'CNAME',
  'TXT',
  'MX',
  'SRV',
  'CAA',
  'NS',
]);
export type DnsRecordType = z.infer<typeof DnsRecordType>;

/**
 * A manual (operator-entered) record. `name` is zone-relative (`'@'` = apex).
 * These pass through composition untouched — they exist because pointing NS at
 * swarmy makes swarmy responsible for MX/TXT/etc., not just web traffic.
 */
export const StaticDnsRecord = z.object({
  name: z.string().min(1),
  type: DnsRecordType,
  value: z.string().min(1),
  ttl: z.number().int().positive().optional(),
  /** MX preference / SRV priority. */
  priority: z.number().int().nonnegative().optional(),
});
export type StaticDnsRecord = z.infer<typeof StaticDnsRecord>;

/** One steerable answer candidate: an ingress+outlet node's public address. */
export const GeoEndpoint = z.object({
  /** Controller (enrollment) node id — provenance/debugging, not on the wire to clients. */
  nodeId: z.string(),
  /** The node's `swarmy.region` label (drives haversine ranking). */
  region: z.string(),
  /** Public IPv4 (`swarmy.node.public-ip` label; override label wins). */
  ip: z.string(),
  /** Live health bit composed by the controller (online AND edge serving). */
  healthy: z.boolean(),
  /** Static preference within a distance tier (higher wins). Default 1. */
  weight: z.number().positive().optional(),
});
export type GeoEndpoint = z.infer<typeof GeoEndpoint>;

/**
 * A hostname answered with per-query steered A records. Derived — never
 * user-entered: ingress routes, status pages, webhooks, AI outlets, and the
 * zone apex/www all become GeoRecords automatically.
 */
export const GeoRecord = z.object({
  /** FQDN (may equal the zone apex). */
  host: z.string().min(1),
  /** Max answers per response (failover spread). */
  maxAnswers: z.number().int().positive().default(2),
  endpoints: z.array(GeoEndpoint),
  /** Provenance for the UI ("where did this record come from?"). */
  source: z
    .enum(['route', 'status-page', 'webhook', 'ai-outlet', 'apex', 'www'])
    .optional(),
});
export type GeoRecord = z.infer<typeof GeoRecord>;

/** An advertised nameserver: a pinned node the registrar delegation points at. */
export const ZoneNameserver = z.object({
  /** Host label within the zone, e.g. `ns1`. */
  label: z.string().min(1),
  /** FQDN, e.g. `ns1.requestflo.com`. */
  fqdn: z.string().min(1),
  /** Glue A value = the pinned node's public IP. */
  ip: z.string().min(1),
  nodeId: z.string(),
});
export type ZoneNameserver = z.infer<typeof ZoneNameserver>;

export const DnsSoa = z.object({
  /** Primary NS FQDN (ns1.<zone>). */
  mname: z.string(),
  /** Zone contact mailbox in SOA form (hostmaster.<zone>). */
  rname: z.string(),
  refresh: z.number().int().positive().default(7200),
  retry: z.number().int().positive().default(3600),
  expire: z.number().int().positive().default(1209600),
  /** Negative-caching TTL. */
  minimum: z.number().int().positive().default(30),
});
export type DnsSoa = z.infer<typeof DnsSoa>;

/** Everything swarmy-dns needs to answer authoritatively for one zone. */
export const DnsZoneSnapshot = z.object({
  /** Zone apex, no trailing dot, lowercase: `requestflo.com`. */
  zone: z.string().min(1),
  /** SOA serial — bumps only when composed content changes. */
  serial: z.number().int().nonnegative(),
  /** Default record TTL (short: geo answers must decay fast). */
  ttl: z.number().int().positive().default(30),
  soa: DnsSoa,
  /** The pinned advertised set — yields apex NS RRset + glue A records. */
  nameservers: z.array(ZoneNameserver),
  geoRecords: z.array(GeoRecord).default([]),
  staticRecords: z.array(StaticDnsRecord).default([]),
});
export type DnsZoneSnapshot = z.infer<typeof DnsZoneSnapshot>;

/** The unit pushed to every DNS node: all of an org's hosted zones. */
export const DnsSnapshotBundle = z.object({
  /** Monotonic per org — swarmy-dns rejects non-increasing versions. */
  version: z.number().int().nonnegative(),
  /** ISO timestamp (controller clock) — display/debugging only. */
  generatedAt: z.string(),
  zones: z.array(DnsZoneSnapshot),
});
export type DnsSnapshotBundle = z.infer<typeof DnsSnapshotBundle>;

export const ApplyDnsPayload = z.object({
  commandId: CommandId,
  timeoutMs: z.number().int().positive().optional(),
  bundle: DnsSnapshotBundle,
  /** Node-local swarmy-dns admin endpoint the agent POSTs the bundle to. */
  adminUrl: z.string().default('http://127.0.0.1:53535'),
  /** Bearer token, JIT-resolved at dispatch (never persisted in clear). */
  adminToken: z.string().optional(),
});
export type ApplyDnsPayload = z.infer<typeof ApplyDnsPayload>;

export const ApplyDnsMsg = z.object({
  type: z.literal('applyDns'),
  payload: ApplyDnsPayload,
});
export type ApplyDnsMsg = z.infer<typeof ApplyDnsMsg>;

/** Typed `applyDns` result for controller-side narrowing. */
export interface ApplyDnsResult {
  applied: boolean;
  /** Bundle version swarmy-dns is now serving. */
  version: number;
  zones: number;
}
