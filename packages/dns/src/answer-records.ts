import type { Answer } from 'dns-packet';
import type { DnsZoneSnapshot, StaticDnsRecord } from '@swarmy/core/protocol';
import { relativeToFqdn } from './compose';

/**
 * Record → wire-answer conversion for `answerQuery` — pure. Split out of
 * answer.ts so the resolution logic there stays readable.
 */

export function soaAnswer(zone: DnsZoneSnapshot): Answer {
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

export function staticToAnswer(record: StaticDnsRecord, zone: DnsZoneSnapshot): Answer {
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
      // A TXT string is at most 255 bytes on the wire (RFC 1035 §3.3.14);
      // longer values (DKIM keys) go out as several strings, which receivers
      // concatenate.
      {
        const parts = txtStrings(record.value);
        return { name, type: 'TXT', ttl, data: parts.length === 1 ? record.value : parts };
      }
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

/** Split a TXT value into ≤255-byte character-strings (UTF-8 safe). */
export function txtStrings(value: string): string[] {
  const buf = Buffer.from(value, 'utf8');
  if (buf.length <= 255) return [value];
  const out: string[] = [];
  let start = 0;
  while (start < buf.length) {
    let end = Math.min(start + 255, buf.length);
    // never cut inside a multi-byte sequence
    while (end < buf.length && end > start && (buf[end]! & 0xc0) === 0x80) end--;
    out.push(buf.subarray(start, end).toString('utf8'));
    start = end;
  }
  return out;
}
