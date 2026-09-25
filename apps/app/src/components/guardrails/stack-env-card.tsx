import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CalmRow, Depth, RowList, Section } from '@/components/calm';

/** Which apps are production (the `swarmy.env=production` label). Mark and unmark from Controls. */
export function StackEnvCard(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const stacks = useQuery({ ...trpc.guardrails.stackEnvs.queryOptions(), refetchInterval: 10_000 });
  const setEnv = useMutation(
    trpc.guardrails.setStackEnv.mutationOptions({
      onSuccess: (r) => {
        toast.success(r.production ? `${r.stack} is now production` : `${r.stack} is no longer production`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const rows = stacks.data ?? [];
  return (
    <Section title="Which apps are production" count={stacks.data ? rows.filter((s) => s.production).length : undefined} flush>
      {stacks.isLoading ? (
        <div aria-hidden className="shimmer-line my-3 h-10 rounded-lg" />
      ) : stacks.isError ? (
        <p className="text-muted-foreground py-4 text-sm">{stacks.error.message}</p>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground py-4 text-sm">No apps running yet. Deploy one, then mark it production here.</p>
      ) : (
        <RowList label="App environments">
          {rows.map((s) => (
            <CalmRow
              key={s.stack}
              tone={s.production ? 'warn' : 'idle'}
              name={s.stack}
              sub={`${s.serviceCount} service${s.serviceCount === 1 ? '' : 's'}`}
              tech={s.production ? 'swarmy.env=production' : 'no swarmy.env label'}
              word={s.production ? 'Production' : 'Not production'}
              trailing={
                <Depth at="controls">
                  <Button variant="ghost" size="sm" className="pointer-coarse:min-h-11" disabled={setEnv.isPending} onClick={() => setEnv.mutate({ stack: s.stack, production: !s.production })}>
                    {s.production ? 'Unmark' : 'Mark production'}
                  </Button>
                </Depth>
              }
            />
          ))}
        </RowList>
      )}
    </Section>
  );
}
