/**
 * Client-side mirrors of the geodns tRPC views (packages/trpc/src/services/
 * dns-zones.service.ts, dns-records.service.ts, geodns.service.ts) so geo
 * components can type props without importing server code.
 */

export type ZoneMode = 'swarmy-ns' | 'cloudflare' | 'route53';

export interface ZoneNameserver {
  label: string;
  fqdn: string;
  ip: string;
  nodeId: string;
  online: boolean;
}

export interface ZoneConflict {
  name: string;
  type: string;
  reason: string;
}

/** Mirror of `DnsZoneView` — the registrar-facing zone artifact. */
export interface DnsZoneView {
  id: string;
  zone: string;
  mode: string;
  enabled: boolean;
  ttl: number;
  serial: number;
  apexToEdge: boolean;
  autoWww: boolean;
  advertisedNodeIds: string[];
  nameservers: ZoneNameserver[];
  provider: { zoneId?: string; tokenEnv?: string; region?: string };
  conflicts?: ZoneConflict[];
}

/** Mirror of `DnsViewRow` — one derived hostname swarmy answers for. */
export interface DnsViewRow {
  host: string;
  zone: string;
  source: string;
  stack?: string;
  endpoints: Array<{ region: string; ip: string; healthy: boolean }>;
  healthyCount: number;
}

/** Mirror of `DnsRecordView` — a manual (non-derived) record. */
export interface DnsRecordView {
  id: string;
  zoneId: string;
  name: string;
  type: string;
  value: string;
  ttl: number | null;
  priority: number | null;
}

export const MANUAL_RECORD_TYPES = ['MX', 'TXT', 'CNAME', 'SRV', 'CAA', 'NS', 'A', 'AAAA'] as const;

export const ZONE_MODES: Array<{ id: ZoneMode; label: string }> = [
  { id: 'swarmy-ns', label: 'swarmy NS' },
  { id: 'cloudflare', label: 'Cloudflare' },
  { id: 'route53', label: 'Route 53' },
];

export function zoneModeLabel(mode: string): string {
  return ZONE_MODES.find((m) => m.id === mode)?.label ?? mode;
}
