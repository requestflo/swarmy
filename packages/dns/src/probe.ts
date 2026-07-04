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
