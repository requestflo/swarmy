import dnsPacket, {
  type Packet,
  type Question,
  type Answer,
  type OptAnswer,
} from 'dns-packet';
import type { EcsInfo } from './geoip';

/**
 * Wire layer — thin, pure wrappers over `dns-packet`. Everything here is
 * Buffer-in/Buffer-out; sockets live in apps/dns. TCP framing (RFC 1035
 * §4.2.2 two-byte length prefix) is handled by dns-packet's stream codecs.
 */

/** EDNS0 client-advertised UDP payload ceiling we honour (RFC 6891/flag day). */
export const EDNS_UDP_PAYLOAD = 1232;
/** Classic DNS-over-UDP ceiling when the client sent no OPT record. */
export const PLAIN_UDP_PAYLOAD = 512;

export interface ParsedQuery {
  packet: Packet;
  /** First (and in practice only) question, or undefined for junk packets. */
  question: Question | undefined;
  /** EDNS Client Subnet, when the resolver forwarded one. */
  ecs: EcsInfo | undefined;
  /** True when the query carried an OPT record (EDNS-aware client). */
  edns: boolean;
  /** Client-advertised UDP payload size (only meaningful when edns). */
  udpPayloadSize: number;
}

export function parseQuery(buf: Uint8Array): ParsedQuery {
  const packet = dnsPacket.decode(Buffer.from(buf));
  const opt = (packet.additionals ?? []).find((a): a is OptAnswer => a.type === 'OPT');
  let ecs: EcsInfo | undefined;
  for (const option of opt?.options ?? []) {
    if (option.type === 'CLIENT_SUBNET' || option.code === 8) {
      const o = option as {
        ip?: string;
        family?: number;
        sourcePrefixLength?: number;
        scopePrefixLength?: number;
      };
      if (o.ip) {
        ecs = {
          ip: o.ip,
          family: o.family ?? 1,
          sourcePrefixLength: o.sourcePrefixLength ?? 0,
          scopePrefixLength: o.scopePrefixLength ?? 0,
        };
      }
    }
  }
  const udp = opt?.udpPayloadSize;
  return {
    packet,
    question: packet.questions?.[0],
    ecs,
    edns: opt !== undefined,
    udpPayloadSize: Math.max(PLAIN_UDP_PAYLOAD, Math.min(udp ?? PLAIN_UDP_PAYLOAD, EDNS_UDP_PAYLOAD)),
  };
}

export type Rcode = 'NOERROR' | 'NXDOMAIN' | 'REFUSED' | 'NOTIMP' | 'FORMERR' | 'SERVFAIL';

export interface ResponseInput {
  query: ParsedQuery;
  rcode: Rcode;
  /** Authoritative answer — true for zones we own (REFUSED responses pass false). */
  aa: boolean;
  answers: Answer[];
  authorities?: Answer[];
  additionals?: Answer[];
  /**
   * ECS scope to echo (RFC 7871): when the answer was steered by the client
   * subnet, scopePrefixLength = sourcePrefixLength so resolvers cache
   * per-subnet; when unsteered, 0 (cache for everyone).
   */
  ecsScopePrefixLength?: number;
}

/** Build the response packet (no size handling — see the encoders below). */
export function buildResponse(input: ResponseInput): Packet {
  const { query } = input;
  const flags =
    (input.aa ? dnsPacket.AUTHORITATIVE_ANSWER : 0) |
    // Echo RD so resolvers see their flag reflected; we never recurse (no RA).
    ((query.packet.flags ?? 0) & dnsPacket.RECURSION_DESIRED);

  const additionals: Answer[] = [...(input.additionals ?? [])];
  if (query.edns) {
    const opt: OptAnswer = {
      name: '.',
      type: 'OPT',
      udpPayloadSize: EDNS_UDP_PAYLOAD,
      extendedRcode: 0,
      ednsVersion: 0,
      flags: 0,
      flag_do: false,
      options: query.ecs
        ? [
            {
              code: 8,
              type: 'CLIENT_SUBNET',
              ip: query.ecs.ip,
              family: query.ecs.family,
              sourcePrefixLength: query.ecs.sourcePrefixLength,
              scopePrefixLength: input.ecsScopePrefixLength ?? 0,
            },
          ]
        : [],
    };
    additionals.push(opt);
  }

  return {
    id: query.packet.id,
    type: 'response',
    flags,
    // NOTIMP/FORMERR responses still echo the question when we parsed one.
    questions: query.question ? [query.question] : [],
    answers: input.answers,
    authorities: input.authorities ?? [],
    additionals,
    // dns-packet encodes rcode via flags on decode but takes `rcode` field too:
    // it maps flag bits from `flags`; rcode must be OR-ed into flags manually.
  } satisfies Packet;
}

const RCODE_BITS: Record<Rcode, number> = {
  NOERROR: 0,
  FORMERR: 1,
  SERVFAIL: 2,
  NXDOMAIN: 3,
  NOTIMP: 4,
  REFUSED: 5,
};

/** Apply the rcode bits into packet flags (dns-packet keeps rcode in flags). */
export function withRcode(packet: Packet, rcode: Rcode): Packet {
  return { ...packet, flags: (packet.flags ?? 0) | RCODE_BITS[rcode] };
}

/**
 * Encode for UDP, honouring the client's payload ceiling: oversized responses
 * are truncated to header+question with the TC bit so the client retries TCP.
 */
export function encodeForUdp(packet: Packet, maxBytes: number): Buffer {
  const full = dnsPacket.encode(packet);
  if (full.byteLength <= maxBytes) return full;
  const truncated: Packet = {
    ...packet,
    flags: (packet.flags ?? 0) | dnsPacket.TRUNCATED_RESPONSE,
    answers: [],
    authorities: [],
    // Keep the OPT record (EDNS negotiation survives truncation).
    additionals: (packet.additionals ?? []).filter((a) => a.type === 'OPT'),
  };
  return dnsPacket.encode(truncated);
}

/** Encode for TCP — dns-packet's streamEncode adds the 2-byte length prefix. */
export function encodeForTcp(packet: Packet): Buffer {
  return dnsPacket.streamEncode(packet);
}

/** Decode one TCP-framed message (buffer must contain the full frame). */
export function decodeFromTcp(buf: Uint8Array): Packet {
  return dnsPacket.streamDecode(Buffer.from(buf));
}
