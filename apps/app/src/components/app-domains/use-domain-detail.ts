import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import type { DomainDetail } from '@/components/ingress/domain-state';
import { countedAtEdge, hostVisits } from '@/lib/host-visits';
import { hostBlocked } from '@/lib/host-blocked';
import { caddyfileOf, siteBlock, storedIn } from './cert-model';
import type { CertFacts } from './cert-facts-model';

/**
 * One address's detail on the Domains tab (board 30): its certificate
 * (`ingress.domainStatus`'s probe, and what the edges hold, `ingress.certFacts`),
 * where certificates live (`ingress.getConfig`),
 * this address's own visits and blocked answers a minute at the edge
 * (`traffic.now.hosts`) and its rendered Caddy site block (`ingress.previewConfig`).
 */
export function useDomainDetail(host: string, routeDriver?: string | null) {
  const trpc = useTRPC();
  const status = useQuery({ ...trpc.ingress.domainStatus.queryOptions({ host }), refetchInterval: 30_000 });
  const facts = useQuery({ ...trpc.ingress.certFacts.queryOptions({ host }), refetchInterval: 60_000, retry: false });
  const config = useQuery(trpc.ingress.getConfig.queryOptions());
  const nodes = useQuery(trpc.nodes.list.queryOptions());
  const traffic = useQuery({ ...trpc.traffic.now.queryOptions(), refetchInterval: 30_000 });
  const caddy = config.data?.driver === 'caddy';
  const preview = useQuery({ ...trpc.ingress.previewConfig.queryOptions({}), enabled: caddy });

  const nameOf = (ip: string): string => (nodes.data ?? []).find((n) => n.publicIp === ip)?.name ?? ip;
  const cs = config.data?.certStorage as { mode: 'shared' | 'local'; bucket: string | null; edges: number; encrypted?: boolean } | undefined;
  const viaEdge = countedAtEdge(routeDriver, config.data?.driver);
  const visits = hostVisits(traffic.data, host, viaEdge);
  const file = caddy ? caddyfileOf(preview.data) : null;
  return {
    detail: (status.data as DomainDetail | undefined) ?? null,
    facts: (facts.data as CertFacts | undefined) ?? null,
    nameOf,
    stored: storedIn(cs),
    storeTech: cs
      ? `certificate store · ${cs.mode === 'shared' ? `shared, local copy + object-storage replica${cs.encrypted ? ' (sealed)' : ''}` : 'local volume per edge'} · ${cs.edges} edge${cs.edges === 1 ? '' : 's'}`
      : null,
    /** This address's visits a minute at the front door; null when there's no number for it. */
    visitsPerMin: visits?.perMin ?? null,
    windowMinutes: visits?.windowMinutes ?? null,
    /** 403 + 429 a minute at this address; null when there's no honest number. */
    blocked: hostBlocked(traffic.data, host, viaEdge),
    caddy: file ? siteBlock(file, host) : null,
  };
}
