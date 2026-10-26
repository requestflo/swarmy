import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import type { AskDecision, CertIssuance } from './edge-certs-model';

/**
 * Edge settings' certificate reads (board 31): what the edges were issued
 * (`ingress.certIssuance`, the edges' storage kept a minute by the
 * controller) and the latest on-demand asks (`ingress.askLog`). undefined
 * while loading, null when unreadable.
 */
export function useEdgeCerts(): { issuance: CertIssuance | null | undefined; askLog: AskDecision[] | null | undefined } {
  const trpc = useTRPC();
  const issuance = useQuery({ ...trpc.ingress.certIssuance.queryOptions(), refetchInterval: 60_000, retry: false });
  const askLog = useQuery({ ...trpc.ingress.askLog.queryOptions(), refetchInterval: 15_000 });
  return {
    issuance: issuance.isError ? null : issuance.data,
    askLog: askLog.isError ? null : askLog.data,
  };
}
