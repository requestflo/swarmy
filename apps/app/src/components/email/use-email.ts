import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/** The Email page's one overview query (domains, credentials, MTA, warnings). */
export function useEmailOverview() {
  const trpc = useTRPC();
  return useQuery({ ...trpc.email.overview.queryOptions(), refetchInterval: 10_000 });
}

export type EmailOverviewData = NonNullable<ReturnType<typeof useEmailOverview>['data']>;
export type EmailDomainData = EmailOverviewData['domains'][number];
export type EmailRecordData = EmailDomainData['records'][number];

interface MaybePolicyError {
  message: string;
  data?: { code?: string; swarmyCode?: string } | null;
}

/** Plain-words toast for a failed email mutation (a policy denial names the fix). */
export function emailErrorToast(e: MaybePolicyError): void {
  const denied = e.data?.swarmyCode === 'POLICY_DENIED' || e.data?.code === 'FORBIDDEN';
  toast.error(denied ? 'Only owners and admins can change email settings — ask one, or have them grant you email.write.' : e.message);
}

/** onSuccess/onError for email mutations: toast, then refresh everything email. */
export function useEmailMutationHandlers(success?: string) {
  const qc = useQueryClient();
  return {
    onSuccess: () => {
      if (success) toast.success(success);
      void qc.invalidateQueries();
    },
    onError: (e: MaybePolicyError) => emailErrorToast(e),
  };
}
