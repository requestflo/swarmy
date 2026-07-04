import type {
  DnsZoneSnapshot,
  GeoEndpoint,
  GeoRecord,
  StaticDnsRecord,
  ZoneNameserver,
} from '@swarmy/core/protocol';

/**
 * Zone composition — pure assembly of a {@link DnsZoneSnapshot} from derived
 * ingress truth + the user's manual records. The controller gathers the inputs
 * (DB zones, live node inventory, ingress hostnames); everything that decides
 * WHAT the zone contains happens here, golden-tested.
 *
 * Web records are DERIVED (invariant #5 in the geo-edge-routing skill): auto
 * hosts come from ingress routes/status pages/webhooks/AI outlets, plus the
 * apex and `www`. Manual records exist for everything else (MX/TXT/…) and WIN
 * on collision — but the collision is surfaced as a conflict for the UI.
 */

export interface ZoneComposeInput {
  zone: {
    /** Apex, lowercase, no trailing dot. */
    name: string;
    ttl: number;
    serial: number;
    /** Answer the apex itself with the edge (default true). */
    apexToEdge: boolean;
    /** Auto-answer `www` unless something else claims it (default true). */
    autoWww: boolean;
  };
  /** Pinned advertised nameserver nodes, in ns1..nsN order. */
  advertised: Array<{ nodeId: string; ip: string }>;
  /** Hostnames derived from ingress, already filtered to this zone. */
  autoHosts: Array<{ host: string; source?: GeoRecord['source'] }>;
  /** All steerable ingress+outlet endpoints (health composed by caller). */
  endpoints: GeoEndpoint[];
  manualRecords: StaticDnsRecord[];
  /** Answers per geo response (failover spread). Default 2. */
  maxAnswers?: number;
}

export interface ComposeConflict {
  name: string;
  type: string;
  reason: string;
}

export interface ComposeResult {
  snapshot: DnsZoneSnapshot;
  /** Non-fatal composition warnings the UI should surface. */
  conflicts: ComposeConflict[];
}

const normalize = (name: string): string => name.toLowerCase().replace(/\.+$/, '');

/** Zone-relative label ('@' for apex) → FQDN within the zone. */
export function relativeToFqdn(name: string, zone: string): string {
  const n = normalize(name);
  return n === '@' || n === '' || n === zone ? zone : `${n}.${zone}`;
}

export function composeZoneSnapshot(input: ZoneComposeInput): ComposeResult {
  const zone = normalize(input.zone.name);
  const conflicts: ComposeConflict[] = [];
  const maxAnswers = Math.max(1, input.maxAnswers ?? 2);

  // ── Nameservers: pinned nodes → ns1..nsN + glue ──
  const nameservers: ZoneNameserver[] = input.advertised.map((node, i) => ({
    label: `ns${i + 1}`,
    fqdn: `ns${i + 1}.${zone}`,
    ip: node.ip,
    nodeId: node.nodeId,
  }));

  // ── Manual records: normalize, filter what we cannot honour ──
  const manual: StaticDnsRecord[] = [];
  for (const record of input.manualRecords) {
    const name = normalize(record.name);
    const fqdn = relativeToFqdn(name, zone);
    if (record.type === 'CNAME' && fqdn === zone) {
      conflicts.push({
        name: fqdn,
        type: 'CNAME',
        reason: 'CNAME at the zone apex is invalid (RFC 1034) — the apex already resolves to the edge; record ignored.',
      });
      continue;
    }
    if (record.type === 'NS' && fqdn === zone) {
      conflicts.push({
        name: fqdn,
        type: 'NS',
        reason: 'Apex NS records are managed by the pinned nameserver set; record ignored.',
      });
      continue;
    }
    manual.push({ ...record, name: name === zone ? '@' : name });
  }

  const manualFqdns = new Map<string, Set<string>>(); // fqdn → set of types
  for (const record of manual) {
    const fqdn = relativeToFqdn(record.name, zone);
    const types = manualFqdns.get(fqdn) ?? new Set<string>();
    types.add(record.type);
    manualFqdns.set(fqdn, types);
  }

  // ── Geo records: apex + www + derived hosts, manual address records win ──
  const geoByHost = new Map<string, GeoRecord>();
  const addGeo = (host: string, source: GeoRecord['source']) => {
    const fqdn = normalize(host);
    if (fqdn !== zone && !fqdn.endsWith(`.${zone}`)) return; // out of zone — caller bug, skip
    if (geoByHost.has(fqdn)) return;
    const manualTypes = manualFqdns.get(fqdn);
    if (manualTypes?.has('A') || manualTypes?.has('AAAA') || manualTypes?.has('CNAME')) {
      conflicts.push({
        name: fqdn,
        type: [...manualTypes].filter((t) => t === 'A' || t === 'AAAA' || t === 'CNAME').join('+'),
        reason: 'Manual address record overrides the automatic geo-steered answer for this host.',
      });
      return; // manual wins
    }
    geoByHost.set(fqdn, {
      host: fqdn,
      maxAnswers,
      endpoints: input.endpoints,
      source,
    });
  };

  if (input.zone.apexToEdge) addGeo(zone, 'apex');
  for (const auto of input.autoHosts) addGeo(auto.host, auto.source ?? 'route');
  if (input.zone.autoWww) addGeo(`www.${zone}`, 'www');

  if (input.endpoints.length === 0 && geoByHost.size > 0) {
    conflicts.push({
      name: zone,
      type: 'A',
      reason: 'No ingress+outlet endpoints with a public IP exist yet — geo hosts will answer empty.',
    });
  }

  const snapshot: DnsZoneSnapshot = {
    zone,
    serial: input.zone.serial,
    ttl: input.zone.ttl,
    soa: {
      mname: nameservers[0]?.fqdn ?? zone,
      rname: `hostmaster.${zone}`,
      refresh: 7200,
      retry: 3600,
      expire: 1209600,
      minimum: Math.min(input.zone.ttl, 300),
    },
    nameservers,
    geoRecords: [...geoByHost.values()].sort((a, b) => (a.host < b.host ? -1 : 1)),
    staticRecords: manual,
  };

  return { snapshot, conflicts };
}
