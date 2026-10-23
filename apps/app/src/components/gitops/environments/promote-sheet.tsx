import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRightIcon } from 'lucide-react';
import { Button, Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, cn, toast } from '@swarmy/ui';
import { TONE_TEXT } from '@/components/calm';
import { ErrorState, TextSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import type { AppEnvironment, PlanActionView } from '../gitops-types';
import { PlanBody } from '../plan-body';
import { envLabel } from '../plan-status';
import { promoteChanges } from './lanes-model';
import { gateLine, PromotePreview } from './promote-preview';

/**
 * Promote an environment to production, as a plan like any push (board
 * Environments): the exact digests it runs (`apps.promote` dryRun — nothing
 * rebuilt, nothing recorded), every step with its gate, then Apply and the
 * steps as they land (`apps.plan`), held ones confirmable (`apps.confirm`).
 */
export function PromoteSheet({ repoId, env, prodImages }: { repoId: string; env: AppEnvironment; prodImages: ReadonlyMap<string, string> }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [planId, setPlanId] = React.useState<string | null>(null);
  const from = envLabel(env.environment).toLowerCase();
  const dry = useMutation(trpc.apps.promote.mutationOptions());
  const apply = useMutation(
    trpc.apps.promote.mutationOptions({
      onSuccess: (r) => {
        setPlanId(r.plan?.id ?? r.planId ?? null);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const plan = useQuery({
    ...trpc.apps.plan.queryOptions({ planId: planId ?? '' }),
    enabled: !!planId,
    refetchInterval: (q) => (q.state.data?.status === 'applying' ? 2_000 : false),
  });
  const onOpen = (next: boolean): void => {
    setOpen(next);
    if (next && !planId) dry.mutate({ repoId, from: env.environment, dryRun: true });
    if (!next && planId) setPlanId(null);
  };

  const preview = dry.data?.preview;
  const moved = dry.data ? promoteChanges(dry.data.images, prodImages) : null;
  const gate = preview && moved ? gateLine(preview.counts, moved.changes.length) : null;
  return (
    <Sheet open={open} onOpenChange={onOpen}>
      <Button variant="outline" size="sm" className="pointer-coarse:min-h-11" onClick={() => onOpen(true)}>
        <ArrowUpRightIcon className="size-3.5" /> Promote {from} → production
      </Button>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <span className="text-muted-foreground font-mono text-[11px] tracking-wide uppercase">Plan · like any push</span>
          <SheetTitle>Promote {from} → production</SheetTitle>
          <SheetDescription>
            Deploys the exact digests {from} is running. Nothing is rebuilt; production’s swarmy.yaml still decides config, and it’s recorded as a release with trigger promote.
          </SheetDescription>
        </SheetHeader>
        {planId ? (
          plan.data ? <PlanBody plan={plan.data} /> : <TextSkeleton className="mx-4 h-4 w-1/2" />
        ) : (
          <div className="flex flex-col gap-4 px-4 pb-8">
            {dry.isError ? (
              <ErrorState title="Couldn't plan the promote" error={dry.error} retry={() => dry.mutate({ repoId, from: env.environment, dryRun: true })} />
            ) : !moved || !preview ? (
              <TextSkeleton className="h-4 w-2/3" />
            ) : (
              <>
                <PromotePreview changes={moved.changes} same={moved.same} actions={preview.actions as PlanActionView[]} />
                {gate ? <span className={cn('text-[13px] font-semibold', TONE_TEXT[gate.tone])}>{gate.text}</span> : null}
                <div className="flex flex-wrap items-center gap-2">
                  <Button disabled={apply.isPending || preview.counts.blocked > 0} onClick={() => apply.mutate({ repoId, from: env.environment })}>
                    {apply.isPending ? 'Promoting…' : 'Apply'}
                  </Button>
                  <span className="text-muted-foreground text-xs">
                    {preview.counts.blocked > 0 ? 'Clear what’s blocked first' : preview.counts.confirm > 0 ? 'Steps that need you wait for a confirm after Apply' : 'Same gates as a push'}
                  </span>
                </div>
              </>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
