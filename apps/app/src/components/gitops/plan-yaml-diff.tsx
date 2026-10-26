import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { CodeView } from '@/components/calm';
import { ErrorState, TextSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { relTime } from '@/lib/format';
import { baseWords, planDiffTabs, type PlanDiff } from './plan-diff-model';

/**
 * The plan drawer's "YAML diff" tab (board 26): swarmy.yaml, and the spec
 * swarmy renders from it, at the live release and at this plan, as unified
 * diffs in the same Code view the edge Caddyfile diff uses. Read-only: the
 * file changes in git.
 */
export function PlanYamlDiff({ planId }: { planId: string }): React.JSX.Element {
  const trpc = useTRPC();
  const q = useQuery({ ...trpc.apps.planDiff.queryOptions({ planId }), staleTime: 60_000, refetchOnWindowFocus: false });
  if (q.isPending) {
    return (
      <div className="space-y-2" aria-busy>
        <TextSkeleton className="h-4 w-2/3" />
        <TextSkeleton className="h-40 w-full" />
      </div>
    );
  }
  if (q.isError) return <ErrorState title="Couldn't build the diff" error={q.error} retry={() => void q.refetch()} />;
  const v = q.data as PlanDiff;
  const applied = v.base?.appliedAt ? ` · applied ${relTime(v.base.appliedAt)}` : '';
  return (
    <CodeView
      always
      title="What this plan changes"
      tabs={planDiffTabs(v)}
      source="readonly"
      toolbar={
        <p className="text-muted-foreground text-[12.5px]">
          Compared with {baseWords(v)}
          {applied}.
        </p>
      }
      note={`Read only. ${v.path} changes in git; the spec is what swarmy renders from it for this environment, signatures left out.`}
    />
  );
}
