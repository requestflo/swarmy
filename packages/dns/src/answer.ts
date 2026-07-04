import type { Answer, Question } from 'dns-packet';
import type {
  DnsZoneSnapshot,
  GeoRecord,
  StaticDnsRecord,
} from '@swarmy/core/protocol';
import { steer, type ClientLocation, type SteerTarget } from './steer';
import { relativeToFqdn } from './compose';
import type { Rcode } from './wire';

/**
 * Per-query authoritative resolution — the heart of "swarmy is the nameserver".
 *
 * Pure: (zones, question, client location) → answer sections. The server layer
 * (apps/dns) handles sockets, EDNS packaging, and metrics; tests exercise this
 * directly with fixture snapshots.
 *
 * Behavioural invariants (geo-edge-routing skill):
 * - Geo hosts answer with the closest HEALTHY node IPs; zero healthy → spill
 *   to all (degraded), never an empty answer because of health.
 * - Names that exist but lack the queried type → NODATA (NOERROR + SOA in
 *   authority); unknown names → NXDOMAIN + SOA. Queries for zones we don't
 *   host → REFUSED (we are authoritative-only, never recursive).
 * - Matching is case-insensitive; the question name is echoed as sent
 *   (0x20-randomization tolerant).
 * - ANY gets the RFC 8482 minimal HINFO response.
 */

export interface DnsAnswer {
  rcode: Rcode;
  /** Authoritative for this zone (false only for REFUSED). */
  aa: boolean;
  answers: Answer[];
  authorities: Answer[];
  additionals: Answer[];
  /** The answer used the client's location (→ echo ECS scope). */
  steered: boolean;
  /** All endpoints were unhealthy and we spilled (metrics/debugging). */
  degraded: boolean;
}

const lower = (name: string): string => name.toLowerCase().replace(/\.+$/, '');

/** Longest-suffix zone match: `app.eu.x.com` → zone `eu.x.com` over `x.com`. */
export function findZone(
  zones: DnsZoneSnapshot[],
  qname: string,
): DnsZoneSnapshot | undefined {
  const name = lower(qname);
  let best: DnsZoneSnapshot | undefined;
  for (const zone of zones) {
    if (name === zone.zone || name.endsWith(`.${zone.zone}`)) {
      if (!best || zone.zone.length > best.zone.length) best = zone;
    }
  }
  return best;
}

function soaAnswer(zone: DnsZoneSnapshot): Answer {
  return {
    name: zone.zone,
    type: 'SOA',
    ttl: zone.soa.minimum,
    data: {
      mname: zone.soa.mname,
      rname: zone.soa.rname,
      serial: zone.serial,
      refresh: zone.soa.refresh,
      retry: zone.soa.retry,
      expire: zone.soa.expire,
      minimum: zone.soa.minimum,
    },
  };
}

function staticToAnswer(record: StaticDnsRecord, zone: DnsZoneSnapshot): Answer {
  const name = relativeToFqdn(record.name, zone.zone);
  const ttl = record.ttl ?? zone.ttl;
  switch (record.type) {
    case 'MX':
      return {
        name,
        type: 'MX',
        ttl,
        data: { preference: record.priority ?? 10, exchange: record.value },
      };
    case 'TXT':
      return { name, type: 'TXT', ttl, data: record.value };
    case 'SRV': {
      // Value format: "weight port target" (priority carried separately).
      const [weight = '0', port = '0', target = ''] = record.value.split(/\s+/);
      return {
        name,
        type: 'SRV',
        ttl,
        data: {
          priority: record.priority ?? 0,
          weight: Number(weight),
          port: Number(port),
          target,
        },
      };
    }
    case 'CAA': {
      // Value format: 'flags tag "value"', e.g. '0 issue "letsencrypt.org"'.
      const match = record.value.match(/^(\d+)\s+(\S+)\s+"?([^"]*)"?$/);
      const tag = match?.[2];
      return {
        name,
        type: 'CAA',
        ttl,
        data: {
          flags: Number(match?.[1] ?? 0),
          tag: tag === 'issuewild' || tag === 'iodef' ? tag : 'issue',
          value: match?.[3] ?? record.value,
        },
      };
    }
    case 'NS':
      return { name, type: 'NS', ttl, data: record.value };
    case 'CNAME':
      return { name, type: 'CNAME', ttl, data: record.value };
    case 'AAAA':
      return { name, type: 'AAAA', ttl, data: record.value };
    case 'A':
      return { name, type: 'A', ttl, data: record.value };
  }
}

interface NameView {
  geo?: GeoRecord;
  statics: StaticDnsRecord[];
  isApex: boolean;
  /** Glue: this name is an advertised nameserver host. */
  nsGlueIps: string[];
  exists: boolean;
}

function viewName(zone: DnsZoneSnapshot, fqdn: string): NameView {
  const geo = zone.geoRecords.find((g) => g.host === fqdn);
  const statics = zone.staticRecords.filter(
    (r) => relativeToFqdn(r.name, zone.zone) === fqdn,
  );
  const nsGlueIps = zone.nameservers.filter((ns) => ns.fqdn === fqdn).map((ns) => ns.ip);
  const isApex = fqdn === zone.zone;

  let exists = isApex || geo !== undefined || statics.length > 0 || nsGlueIps.length > 0;
  if (!exists) {
    // Empty non-terminal: `a.b.zone` existing makes `b.zone` NODATA, not NXDOMAIN.
    const suffix = `.${fqdn}`;
    exists =
      zone.geoRecords.some((g) => g.host.endsWith(suffix)) ||
      zone.nameservers.some((ns) => ns.fqdn.endsWith(suffix)) ||
      zone.staticRecords.some((r) => relativeToFqdn(r.name, zone.zone).endsWith(suffix));
  }
  return { geo, statics, isApex, nsGlueIps, exists };
}

function steerGeo(
  geo: GeoRecord,
  client: ClientLocation,
): { ips: string[]; steered: boolean; degraded: boolean } {
  const targets: SteerTarget[] = geo.endpoints.map((e) => ({
    target: e.ip,
    region: e.region,
    healthy: e.healthy,
    weight: e.weight,
  }));
  if (targets.length === 0) return { ips: [], steered: false, degraded: false };
  const result = steer({ client, targets, maxAnswers: geo.maxAnswers });
  return {
    ips: result.answers.map((t) => t.target),
    steered: !result.unlocated,
    degraded: result.degraded,
  };
}

export function answerQuery(
  zones: DnsZoneSnapshot[],
  question: Question,
  client: ClientLocation,
): DnsAnswer {
  const qname = lower(question.name);
  const zone = findZone(zones, qname);
  if (!zone) {
    return {
      rcode: 'REFUSED',
      aa: false,
      answers: [],
      authorities: [],
      additionals: [],
      steered: false,
      degraded: false,
    };
  }

  const respond = (
    answers: Answer[],
    opts: Partial<Pick<DnsAnswer, 'rcode' | 'authorities' | 'additionals' | 'steered' | 'degraded'>> = {},
  ): DnsAnswer => ({
    rcode: opts.rcode ?? 'NOERROR',
    aa: true,
    answers,
    authorities: opts.authorities ?? (answers.length === 0 ? [soaAnswer(zone)] : []),
    additionals: opts.additionals ?? [],
    steered: opts.steered ?? false,
    degraded: opts.degraded ?? false,
  });

  const view = viewName(zone, qname);
  if (!view.exists) return respond([], { rcode: 'NXDOMAIN' });

  const qtype = question.type?.toUpperCase() ?? 'A';

  // RFC 8482: minimal answer for ANY.
  if (qtype === 'ANY') {
    return respond([
      { name: qname, type: 'HINFO', ttl: zone.ttl, data: { cpu: 'RFC8482', os: '' } } as Answer,
    ]);
  }

  // CNAME interposition: a static CNAME answers every qtype except itself…
  const cname = view.statics.find((r) => r.type === 'CNAME');
  if (cname && qtype !== 'CNAME') {
    const answers: Answer[] = [staticToAnswer(cname, zone)];
    // …and we chase in-zone targets for the queried type.
    const target = lower(cname.value);
    if (target === zone.zone || target.endsWith(`.${zone.zone}`)) {
      const chased = answerQuery([zone], { name: target, type: question.type } as Question, client);
      return respond([...answers, ...chased.answers], {
        steered: chased.steered,
        degraded: chased.degraded,
        authorities: [],
      });
    }
    return respond(answers, { authorities: [] });
  }

  switch (qtype) {
    case 'A': {
      const answers: Answer[] = [];
      let steered = false;
      let degraded = false;
      if (view.geo) {
        const geo = steerGeo(view.geo, client);
        steered = geo.steered;
        degraded = geo.degraded;
        for (const ip of geo.ips) {
          answers.push({ name: qname, type: 'A', ttl: zone.ttl, data: ip });
        }
      }
      for (const ip of view.nsGlueIps) {
        answers.push({ name: qname, type: 'A', ttl: zone.ttl, data: ip });
      }
      for (const record of view.statics.filter((r) => r.type === 'A')) {
        answers.push(staticToAnswer(record, zone));
      }
      return respond(answers, { steered, degraded });
    }
    case 'AAAA': {
      // Geo answers are IPv4-only today; static AAAA still served.
      const answers = view.statics.filter((r) => r.type === 'AAAA').map((r) => staticToAnswer(r, zone));
      return respond(answers);
    }
    case 'NS': {
      if (!view.isApex) {
        const answers = view.statics.filter((r) => r.type === 'NS').map((r) => staticToAnswer(r, zone));
        return respond(answers);
      }
      const answers: Answer[] = zone.nameservers.map((ns) => ({
        name: zone.zone,
        type: 'NS',
        ttl: zone.ttl,
        data: ns.fqdn,
      }));
      const additionals: Answer[] = zone.nameservers.map((ns) => ({
        name: ns.fqdn,
        type: 'A',
        ttl: zone.ttl,
        data: ns.ip,
      }));
      return respond(answers, { additionals });
    }
    case 'SOA':
      return view.isApex
        ? respond([soaAnswer(zone)], { authorities: [] })
        : respond([]);
    case 'MX':
    case 'TXT':
    case 'SRV':
    case 'CAA':
    case 'CNAME': {
      const answers = view.statics.filter((r) => r.type === qtype).map((r) => staticToAnswer(r, zone));
      return respond(answers);
    }
    default:
      // Type we don't host (HTTPS, DNSKEY, …) on an existing name → NODATA.
      return respond([]);
  }
}
