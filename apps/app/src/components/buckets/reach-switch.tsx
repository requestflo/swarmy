import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { cn, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { REACH_LABEL, REACH_MODES, reachBlocked, type ReachMode } from './reach-model';
import type { BucketAccessView } from './use-bucket-reach';

/**
 * Internal · Private network · Public for one bucket (`buckets.setAccess`,
 * admin-only and audited server-side; the edges re-render). A mode that
 * can't be used yet is disabled with the reason as its title.
 */
export function ReachSwitch({ view }: { view: BucketAccessView }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const set = useMutation(
    trpc.buckets.setAccess.mutationOptions({
      onSuccess: (v) => {
        const to = v.mode === 'PUBLIC' ? 'reachable from the internet (a key is still needed)' : v.mode === 'MESH' ? 'reachable from your private network' : 'inside swarmy only';
        toast[v.mode === 'PUBLIC' ? 'warning' : 'success'](`${v.bucket} is ${to}`);
        void qc.invalidateQueries({ queryKey: trpc.buckets.pathKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const current = set.isPending && set.variables ? (set.variables.mode as ReachMode) : (view.mode as ReachMode);
  return (
    <div role="radiogroup" aria-label={`Who can reach ${view.bucket}`} className="border-border bg-background inline-flex w-fit max-w-full flex-wrap gap-0.5 rounded-[11px] border p-[3px]">
      {REACH_MODES.map((mode) => {
        const on = current === mode;
        const blocked = on ? null : reachBlocked(mode, view);
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={set.isPending || blocked !== null}
            title={blocked ?? undefined}
            onClick={() => !on && set.mutate({ bucketId: view.bucketId, mode })}
            className={cn(
              'h-8 rounded-[8px] px-3 text-[13px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed pointer-coarse:min-h-11',
              on ? 'bg-surface-2 text-foreground dark:bg-accent' : 'text-muted-foreground hover:text-foreground disabled:opacity-50',
            )}
          >
            {REACH_LABEL[mode]}
          </button>
        );
      })}
    </div>
  );
}
