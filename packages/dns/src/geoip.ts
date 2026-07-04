import type { LatLon, ClientLocation } from './steer';

/**
 * GeoIP abstraction — the pure side of client location. The swarmy-dns server
 * implements {@link GeoIpReader} over an mmdb (DB-IP Lite by default, MaxMind
 * GeoLite2 when licensed — see apps/dns geoip-manager); tests inject fakes.
 *
 * A missing/failed reader is a first-class state: answers become unsteered
 * (deterministic ordering), never an outage.
 */
export interface GeoIpReader {
  /** IP (v4 or v6 string) → coordinates, or undefined when unknown. */
  lookup(ip: string): LatLon | undefined;
}

export interface EcsInfo {
  /** Client subnet address as sent by the resolver. */
  ip: string;
  /** 1 = IPv4, 2 = IPv6 (RFC 7871). */
  family: number;
  sourcePrefixLength: number;
  scopePrefixLength: number;
}

/**
 * Resolve the best client location estimate for a query:
 * EDNS Client Subnet (the real client's subnet) beats the resolver's own
 * source IP, which is often a datacenter far from the user.
 */
export function ipToClientLocation(
  ecs: EcsInfo | undefined,
  resolverIp: string | undefined,
  reader: GeoIpReader | undefined,
): ClientLocation {
  if (!reader) return {};
  if (ecs?.ip && ecs.sourcePrefixLength > 0) {
    const coord = reader.lookup(ecs.ip);
    if (coord) return { coord };
  }
  if (resolverIp) {
    const coord = reader.lookup(resolverIp);
    if (coord) return { coord };
  }
  return {};
}
