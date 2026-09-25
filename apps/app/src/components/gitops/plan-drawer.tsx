import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { ErrorState, TextSkeleton } from '@/components/states';
import { PlanBody } from './plan-body';
import { envLabel, sha7 } from './plan-status';

interface PlanDrawerProps {
  planId: string | null;
  configPath?: string;
  /** Source environment when this plan came from a promote (the plan row doesn't carry it). */
  promotedFrom?: string;
  onClose: () => void;
}

const TRIGGER: Record<string, string> = {
  push: 'a push',
  pr: 'a pull request',
  manual: 'Deploy now',
  poll: 'a new commit',
  drift: 'a drift check',
  confirm: 'a confirm',
};

/** One plan, step by step: what runs on its own, what waits for you, what's blocked. */
export function PlanDrawer({
  planId,
  configPath,
  promotedFrom,
  onClose,
}: PlanDrawerProps): React.JSX.Element {
  const trpc = useTRPC();
  const plan = useQuery({
    ...trpc.apps.plan.queryOptions({ planId: planId ?? '' }),
    enabled: Boolean(planId),
    refetchInterval: (q) => (q.state.data?.status === 'applying' ? 2000 : false),
  });
  const p = plan.data;
  const qc = useQueryClient();
  // A failed plan re-runs for the SAME commit (audited app.plan.retry).
  const retry = useMutation(
    trpc.apps.retryPlan.mutationOptions({
      onSuccess: () => {
        toast.success('Retrying this commit');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const canRetry = p?.status === 'failed' || p?.status === 'partial';

  return (
    <Sheet open={Boolean(planId)} onOpenChange={(o) => (o ? undefined : onClose())}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{p ? `${envLabel(p.environment)} · ${p.stack}` : 'Plan'}</SheetTitle>
          <SheetDescription>
            {p ? (
              <span className="mono-data">
                {sha7(p.sha)} ·{' '}
                {p.trigger === 'promote'
                  ? `Promoted from ${promotedFrom ? envLabel(promotedFrom).toLowerCase() : 'another environment'}`
                  : `from ${TRIGGER[p.trigger] ?? p.trigger}${p.prNumber && p.trigger === 'pr' ? ` #${p.prNumber}` : ''}`}
              </span>
            ) : null}
          </SheetDescription>
        </SheetHeader>
        {canRetry && planId ? (
          <div className="px-4">
            <Button size="sm" disabled={retry.isPending} onClick={() => retry.mutate({ planId })}>
              Retry this commit
            </Button>
          </div>
        ) : null}
        {plan.isPending ? (
          <div className="space-y-3 px-4">
            <TextSkeleton className="h-4 w-1/2" />
            <TextSkeleton className="h-4 w-2/3" />
          </div>
        ) : plan.isError ? (
          <ErrorState error={plan.error} retry={() => void plan.refetch()} className="mx-4" />
        ) : (
          <PlanBody plan={plan.data} configPath={configPath} />
        )}
      </SheetContent>
    </Sheet>
  );
}
