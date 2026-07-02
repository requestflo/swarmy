import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldCheckIcon, ShieldIcon } from 'lucide-react';
import type { GuardrailsConfigView } from '@swarmy/core';
import { Switch, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/**
 * The big production-safety switch. ON ⇒ every guardrail below is enforced —
 * blocking — on any stack marked production. Statement surface (ink-block).
 */
export function SafetyModeCard({ config }: { config: GuardrailsConfigView }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();

  const setMode = useMutation(
    trpc.guardrails.setSafetyMode.mutationOptions({
      onSuccess: (next) => {
        toast.success(
          next.productionSafetyMode
            ? 'Production safety mode ON — every rule blocks on production stacks'
            : 'Production safety mode off — per-rule settings apply',
        );
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const on = config.productionSafetyMode;

  return (
    <section className="ink-block rounded-2xl p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-start gap-4">
          {on ? (
            <ShieldCheckIcon className="text-status-online mt-1 size-8 shrink-0" />
          ) : (
            <ShieldIcon className="mt-1 size-8 shrink-0 opacity-60" />
          )}
          <div className="min-w-0">
            <h2 className="headline text-2xl sm:text-3xl">
              Production safety mode is {on ? <em>on</em> : <>off</>}.
            </h2>
            <p className="mt-1.5 max-w-xl text-sm opacity-80">
              One switch: every rule below is enforced — blocking — on any stack marked{' '}
              <span className="mono-data">production</span>. Per-rule settings still govern
              everything else.
            </p>
          </div>
        </div>
        <label className="flex shrink-0 cursor-pointer items-center gap-3">
          <span className="mono-label !mb-0 opacity-80">{on ? 'Armed' : 'Off'}</span>
          <Switch
            checked={on}
            disabled={setMode.isPending}
            onCheckedChange={(v) => setMode.mutate({ enabled: v })}
            className="scale-125"
          />
        </label>
      </div>
    </section>
  );
}
