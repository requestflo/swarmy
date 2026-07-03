import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FactoryIcon } from 'lucide-react';
import { StatusBadge, Switch, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { RULE_COPY } from '@/components/guardrails/rule-copy';

interface StackEnvironmentCardProps {
  stack: string;
}

/**
 * Environment marking for ONE stack — Docker truth (`swarmy.env=production`
 * stamped on every service). Marking production arms the prod-scoped
 * guardrails, listed right here so the flip is never a surprise.
 */
export function StackEnvironmentCard({ stack }: StackEnvironmentCardProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const envs = useQuery({ ...trpc.guardrails.stackEnvs.queryOptions(), refetchInterval: 5_000 });
  const config = useQuery({ ...trpc.guardrails.config.queryOptions(), refetchInterval: 15_000 });
  const setEnv = useMutation(
    trpc.guardrails.setStackEnv.mutationOptions({
      onSuccess: (r) => {
        toast.success(r.production ? `${stack} is now production` : `${stack} unmarked — dev rules apply`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const row = envs.data?.find((e) => e.stack === stack);
  const production = row?.production ?? false;
  const armed = (config.data?.rules ?? []).filter((r) => r.enabled && r.prodOnly);
  const safetyOn = config.data?.productionSafetyMode ?? false;

  return (
    <section className="card-pop p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <span className="bg-muted text-muted-foreground flex size-9 items-center justify-center rounded-lg">
            <FactoryIcon className="size-5" />
          </span>
          <p className="font-semibold">Environment</p>
        </div>
        <StatusBadge tone={production ? 'warning' : 'neutral'} label={production ? 'production' : 'unmarked'} />
      </div>

      {envs.isLoading ? (
        <div className="mt-4 space-y-2">
          <div className="shimmer-line h-10 rounded-lg" />
          <div className="shimmer-line h-10 rounded-lg" />
        </div>
      ) : (
        <>
          <div className="mt-4 flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Mark as production</p>
              <p className="text-muted-foreground text-xs">
                Stamps <span className="mono-data">swarmy.env=production</span> on all{' '}
                {row?.serviceCount ?? 0} services — deploy admission treats this stack as the real
                thing.
              </p>
            </div>
            <Switch
              checked={production}
              disabled={setEnv.isPending || !row}
              onCheckedChange={(v) => setEnv.mutate({ stack, production: v })}
            />
          </div>

          {armed.length > 0 ? (
            <div className="mt-4">
              <p className="mono-label">{production ? 'Guardrails armed' : `Marking arms ${armed.length} guardrails`}</p>
              <div className="divide-border divide-y">
                {armed.map((r) => (
                  <div key={r.id} className="flex items-center justify-between gap-3 py-2">
                    <p className="text-sm">{RULE_COPY[r.id].title}</p>
                    <StatusBadge
                      tone={r.severity === 'block' ? 'offline' : 'warning'}
                      label={r.severity === 'block' ? 'blocks' : 'warns'}
                    />
                  </div>
                ))}
              </div>
              {production && safetyOn ? (
                <p className="text-muted-foreground mt-2 text-xs">
                  Production safety mode is ON — every enabled rule blocks on this stack.
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
