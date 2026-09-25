import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import type { Tone } from '@/components/calm';

/** The fields the Network hub reads off `ingress.listDomains`. */
export interface HubDomain {
  id: string;
  host: string;
  stack: string;
  serviceName: string;
  targetPort: number;
  tls: string;
  pathPrefix: string | null;
  serving: boolean;
  auto?: boolean;
  status?: { state: string; reason: string; certificate: { expiresAt: string | null } | null } | null;
}

const DAY = 86_400_000;

/** Days until the certificate renews itself (Let's Encrypt renews ~30 days before expiry). */
export function renewsInDays(expiresAt: string | null | undefined): number | null {
  if (!expiresAt) return null;
  const ms = new Date(expiresAt).getTime() - 30 * DAY - Date.now();
  return Math.max(0, Math.round(ms / DAY));
}

/** A domain's plain state: tone, status word and one sentence. */
export function domainSay(d: HubDomain): { tone: Tone; word: string; say: string } {
  const state = d.status?.state ?? (d.serving ? 'active' : 'waiting_dns');
  if (!d.serving) return { tone: 'idle', word: 'Idle', say: 'Not served: the front door is off' };
  if (state === 'waiting_dns') return { tone: 'warn', word: 'Needs you', say: 'Waiting for the address record at your registrar' };
  if (state === 'verified' || state === 'issuing') return { tone: 'info', word: 'Getting HTTPS', say: 'Address found, getting its certificate' };
  if (state === 'error') return { tone: 'bad', word: 'Needs you', say: d.status?.reason ?? 'HTTPS failed' };
  if (d.tls === 'off') return { tone: 'warn', word: 'Online', say: 'Plain HTTP, no certificate' };
  const days = renewsInDays(d.status?.certificate?.expiresAt);
  return { tone: 'ok', word: 'Online', say: days === null ? 'HTTPS on' : `HTTPS · renews itself in ${days} days` };
}

/** Everything the Network hub needs, settled together (never a fake zero). */
export function useNetwork() {
  const trpc = useTRPC();
  const config = useQuery({ ...trpc.ingress.getConfig.queryOptions(), refetchInterval: 10_000 });
  const domains = useQuery({ ...trpc.ingress.listDomains.queryOptions(), refetchInterval: 10_000 });
  const geo = useQuery(trpc.geodns.getConfig.queryOptions());
  const zones = useQuery(trpc.geodns.listZones.queryOptions());
  const rows = (domains.data ?? []) as HubDomain[];
  const onHttps = rows.filter((d) => d.serving && d.tls !== 'off' && (d.status?.state ?? 'active') === 'active').length;
  const needs = rows.filter((d) => domainSay(d).tone === 'warn' || domainSay(d).tone === 'bad');
  const frontDoors = config.data ? Math.max(1, config.data.certStorage?.edges ?? 1) : 0;
  return {
    ready: config.isSuccess && domains.isSuccess,
    error: config.error ?? domains.error,
    retry: () => void Promise.all([config.refetch(), domains.refetch()]),
    config: config.data,
    domains: rows,
    onHttps,
    needs,
    frontDoors,
    geoOn: !!geo.data?.enabled,
    zones: zones.data ?? [],
  };
}
