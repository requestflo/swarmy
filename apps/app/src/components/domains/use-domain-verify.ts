import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import type { DomainDetail, DomainPlan, WwwMode } from '@/components/ingress/domain-state';

/** A clock that ticks once a second, for "next in 18 s". */
export function useNow(): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** Everything the verification view reads and does for one host. */
export function useDomainVerify(host: string) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const status = useQuery({
    ...trpc.ingress.domainStatus.queryOptions({ host }),
    // Right after "Add" the route label may still be landing: keep asking.
    refetchInterval: (q) => (q.state.status === 'error' ? 3_000 : 10_000),
    retry: 4,
  });
  const domains = useQuery(trpc.ingress.listDomains.queryOptions());
  const plan = useQuery(trpc.ingress.domainPlan.queryOptions({ host }));
  const route = (domains.data ?? []).find((d) => d.host === host || d.companionHost === host) ?? null;
  const done = () => void qc.invalidateQueries();
  const verify = useMutation(
    trpc.ingress.verifyDomain.mutationOptions({
      onSuccess: (d) => {
        qc.setQueryData(trpc.ingress.domainStatus.queryKey({ host }), d);
        done();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const skip = useMutation(
    trpc.ingress.skipDomainVerification.mutationOptions({ onSuccess: done, onError: (e) => toast.error(e.message) }),
  );
  const setWww = useMutation(
    trpc.ingress.setDomainWww.mutationOptions({ onSuccess: done, onError: (e) => toast.error(e.message) }),
  );
  const planData = (plan.data as DomainPlan | undefined) ?? null;
  const edgeName = (ip: string): string => planData?.edges.find((e) => e.ip === ip)?.name ?? ip;
  return {
    plan: planData,
    detail: (status.data as DomainDetail | undefined) ?? null,
    error: status.error,
    route,
    edgeName,
    check: () => verify.mutate({ host }),
    checking: verify.isPending,
    skip: () => skip.mutate({ host }),
    skipping: skip.isPending,
    saveWww: (www: WwwMode | null) => (route ? setWww.mutate({ id: route.id, www }) : undefined),
    savingWww: setWww.isPending,
  };
}

export type DomainVerify = ReturnType<typeof useDomainVerify>;
