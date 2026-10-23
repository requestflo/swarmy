import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';

/** The edge's switches are admin calls (`adminProcedure`): owners and admins only. Undefined while unknown. */
export function useIsAdmin(): boolean | undefined {
  const trpc = useTRPC();
  const org = useQuery(trpc.org.currentOrg.queryOptions());
  if (!org.data) return undefined;
  return org.data.role === 'owner' || org.data.role === 'admin';
}
