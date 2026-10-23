import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import type { AskEndpoint } from './ask-model';
import type { DnsZoneView } from './geo-types';

/**
 * Everything the Geo-DNS tab reads: the org's DNS config (live runtime),
 * zones, servers (names for public IPs), the derived web records and the
 * picked zone's own records. `zoneName` is the `?zone=` pick; else the first
 * zone swarmy serves itself.
 */
export function useGeoDnsPage(zoneName?: string) {
  const trpc = useTRPC();
  const config = useQuery({ ...trpc.geodns.getConfig.queryOptions(), refetchInterval: 5000 });
  const zones = useQuery({ ...trpc.geodns.listZones.queryOptions(), refetchInterval: 10_000 });
  const nodes = useQuery(trpc.nodes.list.queryOptions());
  const view = useQuery({ ...trpc.geodns.dnsView.queryOptions({}), refetchInterval: 10_000 });
  const list = (zones.data ?? []) as DnsZoneView[];
  const zone = list.find((z) => z.zone === zoneName) ?? list.find((z) => z.mode === 'swarmy-ns') ?? list[0] ?? null;
  const records = useQuery({ ...trpc.geodns.listRecords.queryOptions({ zoneId: zone?.id ?? '' }), enabled: !!zone });

  const nameOf = (ip: string): string => (nodes.data ?? []).find((n) => n.publicIp === ip)?.name ?? ip;
  const rows = (view.data ?? []).filter((r) => r.zone === zone?.zone);
  // Every front door that answers for this zone (the same set for every derived host).
  const byIp = new Map<string, AskEndpoint>();
  for (const r of rows) {
    for (const e of r.endpoints) {
      const prev = byIp.get(e.ip);
      byIp.set(e.ip, { region: e.region, ip: e.ip, healthy: (prev?.healthy ?? false) || e.healthy, name: nameOf(e.ip) });
    }
  }
  // Ask about the apex when swarmy answers it, else the zone's first address.
  const askHost = rows.find((r) => r.host === zone?.zone)?.host ?? rows[0]?.host ?? null;

  return {
    ready: config.isSuccess && zones.isSuccess,
    error: config.error ?? zones.error,
    retry: () => void Promise.all([config.refetch(), zones.refetch()]),
    config: config.data,
    zones: list,
    zone,
    nodes: nodes.data ?? [],
    rows,
    rowsReady: view.isSuccess,
    records: records.data ?? [],
    recordsReady: records.isSuccess || !zone,
    endpoints: [...byIp.values()].sort((a, b) => a.name.localeCompare(b.name)),
    askHost,
    nameOf,
  };
}

export type GeoDnsPageData = ReturnType<typeof useGeoDnsPage>;
