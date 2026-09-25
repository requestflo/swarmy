import dnsPacket, { type Packet } from 'dns-packet';

/**
 * Pure wire helpers for the controller's delegation checker: build a direct
 * SOA query for a zone and pull the serial out of the reply. The socket work
 * stays with the caller (dns-zones.service) — these are just bytes.
 */

export function encodeSoaQuery(zone: string, id: number): Buffer {
  return dnsPacket.encode({
    id: id & 0xffff,
    type: 'query',
    questions: [{ name: zone, type: 'SOA' }],
  } as Packet);
}

/** Serial from an SOA answer, or null on anything unexpected. */
export function decodeSoaSerial(buf: Uint8Array): number | null {
  try {
    const decoded = dnsPacket.decode(Buffer.from(buf));
    const soa = decoded.answers?.find((a) => a.type === 'SOA') as
      | { data?: { serial?: number } }
      | undefined;
    return soa?.data?.serial ?? null;
  } catch {
    return null;
  }
}

/**
 * A recursive TXT query (RD set, EDNS 1232) for a system resolver. Bun's
 * `dns.resolveTxt` returns every character-string of a TXT record as its own
 * record, so a >255-byte DKIM key reads back as two "records" and never
 * matches — the email checker asks the resolver itself with these bytes.
 */
export function encodeTxtQuery(name: string, id: number): Buffer {
  return dnsPacket.encode({
    id: id & 0xffff,
    type: 'query',
    flags: dnsPacket.RECURSION_DESIRED,
    questions: [{ name, type: 'TXT' }],
    additionals: [{ type: 'OPT', name: '.', udpPayloadSize: 1232 } as never],
  } as Packet);
}

/**
 * TXT records from a reply, each record's strings joined (RFC 7208 §3.3).
 * `[]` for NXDOMAIN / no data; `null` when the reply is truncated, failed or
 * unreadable (the caller falls back).
 */
export function decodeTxtAnswers(buf: Uint8Array): string[] | null {
  try {
    const d = dnsPacket.decode(Buffer.from(buf)) as Packet & { rcode?: string; flag_tc?: boolean };
    if (d.flag_tc) return null;
    if (d.rcode === 'NXDOMAIN') return [];
    if (d.rcode && d.rcode !== 'NOERROR') return null;
    return (d.answers ?? [])
      .filter((a) => a.type === 'TXT')
      .map((a) => {
        const data = (a as { data: Buffer | string | (Buffer | string)[] }).data;
        const parts = Array.isArray(data) ? data : [data];
        return parts.map((p) => (typeof p === 'string' ? p : Buffer.from(p).toString('utf8'))).join('');
      });
  } catch {
    return null;
  }
}
