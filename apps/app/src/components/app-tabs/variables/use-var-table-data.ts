import { useQueries, useQuery } from '@tanstack/react-query';
import type { InvService, SecretFamilyView, ServiceSecretVarView } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { useStackServices } from '../use-stack-services';

export interface VarTableData {
  services: InvService[] | undefined;
  families: SecretFamilyView[] | undefined;
  /** serviceId → its secret variables (metadata only, never a value). */
  vars: Record<string, ServiceSecretVarView[] | undefined>;
  /** Every read has landed (a number shows only once settled). */
  ready: boolean;
  error: unknown;
}

/** One app environment's variables: live env (inventory), its secret families and each service's secret variables. */
export function useVarTableData(stack: string): VarTableData {
  const trpc = useTRPC();
  const { services, error } = useStackServices(stack);
  const secrets = useQuery({ ...trpc.secrets.list.queryOptions({ stack }), refetchInterval: 5_000 });
  const ids = (services ?? []).map((s) => s.id);
  const varQs = useQueries({
    queries: ids.map((id) => ({ ...trpc.services.secretVars.queryOptions({ id }), staleTime: 15_000, refetchInterval: 30_000 })),
  });
  const vars: VarTableData['vars'] = {};
  ids.forEach((id, i) => {
    vars[id] = varQs[i]?.data;
  });
  return {
    services,
    families: secrets.data?.families,
    vars,
    ready: !!services && !!secrets.data && varQs.every((q) => !q.isPending),
    error: error ?? secrets.error,
  };
}
