import { describe, expect, it } from 'bun:test';
import dnsPacket, { type Packet } from 'dns-packet';

/** dns-packet sets `rcode` at runtime; @types omits it. */
const rcodeOf = (d: unknown): string => (d as { rcode: string }).rcode;
import {
  buildResponse,
  decodeFromTcp,
  encodeForTcp,
  encodeForUdp,
  parseQuery,
  withRcode,
  EDNS_UDP_PAYLOAD,
  PLAIN_UDP_PAYLOAD,
} from './wire';

function encodeQuery(packet: Partial<Packet>): Buffer {
  return dnsPacket.encode({
    id: 1234,
    type: 'query',
    flags: dnsPacket.RECURSION_DESIRED,
    questions: [{ name: 'app.example.com', type: 'A' }],
    ...packet,
  } as Packet);
}

describe('parseQuery', () => {
  it('parses a plain query (no EDNS)', () => {
    const parsed = parseQuery(encodeQuery({}));
    expect(parsed.question).toMatchObject({ name: 'app.example.com', type: 'A' });
    expect(parsed.edns).toBe(false);
    expect(parsed.ecs).toBeUndefined();
    expect(parsed.udpPayloadSize).toBe(PLAIN_UDP_PAYLOAD);
  });

  it('extracts EDNS Client Subnet (v4)', () => {
    const parsed = parseQuery(
      encodeQuery({
        additionals: [
          {
            name: '.',
            type: 'OPT',
            udpPayloadSize: 4096,
            options: [
              { code: 8, type: 'CLIENT_SUBNET', ip: '196.25.0.0', sourcePrefixLength: 16 },
            ],
          } as never,
        ],
      }),
    );
    expect(parsed.edns).toBe(true);
    expect(parsed.ecs).toMatchObject({ ip: '196.25.0.0', sourcePrefixLength: 16 });
    // Client advertised 4096 but we clamp to the flag-day ceiling.
    expect(parsed.udpPayloadSize).toBe(EDNS_UDP_PAYLOAD);
  });
});

describe('buildResponse / encode', () => {
  const query = parseQuery(
    encodeQuery({
      additionals: [
        {
          name: '.',
          type: 'OPT',
          udpPayloadSize: 1400,
          options: [
            { code: 8, type: 'CLIENT_SUBNET', ip: '196.25.0.0', sourcePrefixLength: 16 },
          ],
        } as never,
      ],
    }),
  );

  it('round-trips an authoritative steered answer with ECS scope echo', () => {
    const response = withRcode(
      buildResponse({
        query,
        rcode: 'NOERROR',
        aa: true,
        answers: [{ name: 'app.example.com', type: 'A', ttl: 30, data: '198.51.100.20' }],
        ecsScopePrefixLength: 16,
      }),
      'NOERROR',
    );
    const decoded = dnsPacket.decode(encodeForUdp(response, EDNS_UDP_PAYLOAD));
    expect(decoded.id).toBe(1234);
    expect(decoded.type).toBe('response');
    expect(decoded.flag_aa).toBe(true);
    expect(decoded.flag_rd).toBe(true); // echoed
    expect(rcodeOf(decoded)).toBe('NOERROR');
    expect(decoded.answers?.[0]).toMatchObject({ type: 'A', data: '198.51.100.20' });
    const opt = decoded.additionals?.find((a) => a.type === 'OPT') as {
      options?: Array<{ scopePrefixLength?: number; ip?: string }>;
    };
    expect(opt?.options?.[0]).toMatchObject({ ip: '196.25.0.0', scopePrefixLength: 16 });
  });

  it('encodes NXDOMAIN rcode', () => {
    const response = withRcode(
      buildResponse({ query, rcode: 'NXDOMAIN', aa: true, answers: [] }),
      'NXDOMAIN',
    );
    const decoded = dnsPacket.decode(encodeForUdp(response, EDNS_UDP_PAYLOAD));
    expect(rcodeOf(decoded)).toBe('NXDOMAIN');
  });

  it('truncates oversized UDP responses with TC, keeping the OPT record', () => {
    const answers = Array.from({ length: 100 }, (_, i) => ({
      name: 'app.example.com',
      type: 'A' as const,
      ttl: 30,
      data: `192.0.2.${i + 1}`,
    }));
    const response = buildResponse({ query, rcode: 'NOERROR', aa: true, answers });
    const buf = encodeForUdp(response, 512);
    expect(buf.byteLength).toBeLessThanOrEqual(512);
    const decoded = dnsPacket.decode(buf);
    expect(decoded.flag_tc).toBe(true);
    expect(decoded.answers).toEqual([]);
    expect(decoded.additionals?.some((a) => a.type === 'OPT')).toBe(true);
  });

  it('TCP framing round-trips (length-prefixed)', () => {
    const response = buildResponse({
      query,
      rcode: 'NOERROR',
      aa: true,
      answers: [{ name: 'app.example.com', type: 'A', ttl: 30, data: '203.0.113.10' }],
    });
    const framed = encodeForTcp(response);
    expect(framed.readUInt16BE(0)).toBe(framed.byteLength - 2);
    const decoded = decodeFromTcp(framed);
    expect(decoded.answers?.[0]).toMatchObject({ data: '203.0.113.10' });
  });
});
