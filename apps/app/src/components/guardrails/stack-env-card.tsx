import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FactoryIcon } from 'lucide-react';
import { Button, StatusBadge, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/**
 * Stack environment editor: which stacks are production. Docker truth — the
 * `swarmy.env=production` label on the stack's services. Prod-scoped guardrails
 * only bite stacks marked here.
 */
export function StackEnvCard(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();

  const stacks = useQuery({
    ...trpc.guardrails.stackEnvs.queryOptions(),
    refetchInterval: 10_000,
  });
  const setEnv = useMutation(
    trpc.guardrails.setStackEnv.mutationOptions({
      onSuccess: (r) => {
        toast.success(
          r.production ? `${r.stack} is now production` : `${r.stack} unmarked — dev rules apply`,
        );
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const rows = stacks.data ?? [];

  return (
    <section className="card-pop overflow-hidden">
      <header className="border-border border-b px-5 py-3">
        <span className="mono-label !mb-0">Environments</span>
        <p className="text-muted-foreground text-xs">
          Mark a stack as production to arm the prod-scoped rules for it.
        </p>
      </header>

      {stacks.isLoading ? (
        <div className="space-y-3 p-5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="shimmer-line h-10 rounded-lg" />
          ))}
        </div>
      ) : stacks.isError ? (
        <p className="text-muted-foreground px-5 py-4 text-sm">{stacks.error.message}</p>
      ) : rows.length === 0 ? (
        <div className="flex items-start gap-3 px-5 py-4">
          <FactoryIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
          <p className="text-muted-foreground text-sm">
            No stacks running yet — deploy one, then mark it production here.
          </p>
        </div>
      ) : (
        <div className="divide-border divide-y">
          {rows.map((s) => (
            <div key={s.stack} className="flex items-center justify-between gap-3 px-5 py-3">
              <div className="min-w-0">
                <span className="mono-data block truncate text-sm font-semibold">{s.stack}</span>
                <span className="text-muted-foreground text-xs">
                  {s.serviceCount} service{s.serviceCount === 1 ? '' : 's'}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {s.production ? (
                  <StatusBadge tone="warning" label="production" />
                ) : (
                  <StatusBadge tone="neutral" label="dev" />
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full font-bold"
                  disabled={setEnv.isPending}
                  onClick={() => setEnv.mutate({ stack: s.stack, production: !s.production })}
                >
                  {s.production ? 'Unmark' : 'Mark production'}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
