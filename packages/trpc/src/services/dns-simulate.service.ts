import { TRPCError } from '@trpc/server';
import { simulateEdgesDown, type DownOutcome } from '@swarmy/dns';
import type { DnsZoneSnapshot } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { notFound } from '../errors';
import { composeZone } from './dns-snapshot.service';
import { dnsZoneRepo } from './geodns.repo';

/**
 * "Simulate an edge down" (board 32): which front doors would answer each
 * visitor region if the edge at `ip` went down. Read-only — it composes the
 * zone exactly as the next push would, runs the pure `simulateEdgesDown`
 * (the real answering engine, the edge marked unhealthy) and returns the
 * outcome. No snapshot is stored or pushed and no health is changed.
 */

export interface DownSimulationView {
  host: string;
  /** How long visitors keep an answer (the zone TTL). */
  ttl: number;
  /** The edge as it is now (it may already be down). */
  down: { ip: string; region: string; healthy: boolean };
  regions: DownOutcome[];
}

export interface DownSimulationDeps {
  snapshot: (ctx: OrgContext, zoneId: string) => Promise<DnsZoneSnapshot>;
}

const DEFAULT_DEPS: DownSimulationDeps = {
  snapshot: async (ctx, zoneId) => {
    const row = await dnsZoneRepo.find(ctx, ctx.activeOrgId, zoneId);
    if (!row) throw notFound('dnsZone', zoneId);
    return (await composeZone(ctx, row)).snapshot;
  },
};

export async function simulateEdgeDown(
  ctx: OrgContext,
  zoneId: string,
  input: { host: string; ip: string; regions: string[] },
  deps: DownSimulationDeps = DEFAULT_DEPS,
): Promise<DownSimulationView> {
  const snapshot = await deps.snapshot(ctx, zoneId);
  const edge = snapshot.geoRecords.flatMap((g) => g.endpoints).find((e) => e.ip === input.ip);
  if (!edge) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: `${input.ip} is not a front door that answers for ${snapshot.zone}` });
  }
  return {
    host: input.host,
    ttl: snapshot.ttl,
    down: { ip: edge.ip, region: edge.region, healthy: edge.healthy },
    regions: simulateEdgesDown([snapshot], input.host, [input.ip], input.regions),
  };
}
