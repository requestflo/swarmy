/**
 * `@swarmy/dns` — pure, IO-free authoritative DNS domain logic, shared by the
 * controller (`@swarmy/trpc`), the reconcile worker (`apps/api`), and the
 * swarmy-dns server (`apps/dns`). One implementation, three consumers — never
 * inline copies (see the `geo-edge-routing` skill).
 *
 * Wire/snapshot types are owned by `@swarmy/core/protocol` and re-exported here,
 * mirroring how `@swarmy/mesh`/`@swarmy/ingress` re-export their protocol types.
 */
export * from './steer';
export * from './compose';
export * from './answer';
export * from './wire';
export * from './geoip';
export * from './probe';
export * from './signature';

// Protocol re-exports (canonical home: @swarmy/core/protocol/dns).
export {
  DnsRecordType,
  StaticDnsRecord,
  GeoEndpoint,
  GeoRecord,
  ZoneNameserver,
  DnsSoa,
  DnsZoneSnapshot,
  DnsSnapshotBundle,
  ApplyDnsPayload,
  ApplyDnsMsg,
  type ApplyDnsResult,
} from '@swarmy/core/protocol';
