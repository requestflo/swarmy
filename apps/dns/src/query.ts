import {
  answerQuery,
  buildResponse,
  ipToClientLocation,
  parseQuery,
  withRcode,
  type GeoIpReader,
  type ParsedQuery,
} from '@swarmy/dns';
import type { Packet } from 'dns-packet';
import type { SnapshotStore } from './store';
import { recordQuery, type DnsMetrics } from './metrics';

/**
 * Transport-agnostic query pipeline: raw packet in → response packet out.
 * UDP and TCP servers share this; size handling stays in the transports.
 */
export interface QueryContext {
  store: SnapshotStore;
  metrics: DnsMetrics;
  geoip: () => GeoIpReader | undefined;
}

export interface HandledQuery {
  packet: Packet;
  parsed: ParsedQuery;
}

export function handleQuery(
  ctx: QueryContext,
  raw: Uint8Array,
  resolverIp: string | undefined,
): HandledQuery | undefined {
  let parsed: ParsedQuery;
  try {
    parsed = parseQuery(raw);
  } catch {
    ctx.metrics.parseErrors += 1;
    return undefined; // junk packet — drop, don't amplify
  }
  if (parsed.packet.type !== 'query' || !parsed.question) {
    ctx.metrics.parseErrors += 1;
    return undefined;
  }

  const zones = ctx.store.current?.zones ?? [];
  const client = ipToClientLocation(parsed.ecs, resolverIp, ctx.geoip());
  const result = answerQuery(zones, parsed.question, client);

  recordQuery(ctx.metrics, result.rcode, result);

  const packet = withRcode(
    buildResponse({
      query: parsed,
      rcode: result.rcode,
      aa: result.aa,
      answers: result.answers,
      authorities: result.authorities,
      additionals: result.additionals,
      // Steered by the client subnet → per-subnet cacheable; else global.
      ecsScopePrefixLength:
        result.steered && parsed.ecs ? parsed.ecs.sourcePrefixLength : 0,
    }),
    result.rcode,
  );
  return { packet, parsed };
}
