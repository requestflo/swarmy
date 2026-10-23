import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { InvService } from '@swarmy/core';
import type { ServiceSpec } from '@swarmy/core/protocol';
import { cn, toast } from '@swarmy/ui';
import { Section, Tech } from '@/components/calm';
import { orderOf, parallelismOf, type DeployOrder } from '@/components/service-settings/settings-model';
import { CardSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';

const PICKS: { value: DeployOrder; label: string; sub: string }[] = [
  { value: 'start-first', label: 'Start new first', sub: 'A new copy starts and passes its health check before an old one stops. Nothing goes dark.' },
  { value: 'stop-first', label: 'Stop old first', sub: 'An old copy stops, then its replacement starts. For parts that must never run twice.' },
];

/** "When a new version ships" (board AppRollout): start-first or stop-first, applied to the live service. */
export function DeployOrderSection({ name, inv, spec }: { name: string; inv: InvService; spec: ServiceSpec | null | undefined }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const save = useMutation(
    trpc.services.update.mutationOptions({
      onSuccess: (_r, v) => {
        toast.success(v.updateOrder === 'start-first' ? `${name} now starts new copies first` : `${name} now stops old copies first`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const order = save.isPending && save.variables?.updateOrder ? save.variables.updateOrder : spec ? orderOf(spec) : undefined;
  const one = inv.replicas.desired <= 1;
  return (
    <Section title="When a new version ships" hint={spec ? `${parallelismOf(spec)} copy at a time` : undefined}>
      {spec === undefined ? (
        <CardSkeleton lines={2} />
      ) : (
        <>
          <div role="group" aria-label={`How ${name} is replaced`} className="grid gap-2 sm:grid-cols-2">
            {PICKS.map((p) => {
              const on = p.value === order;
              return (
                <button
                  key={p.value}
                  type="button"
                  aria-pressed={on}
                  disabled={!spec || save.isPending}
                  onClick={() => !on && save.mutate({ id: inv.id, updateOrder: p.value })}
                  className={cn(
                    'flex min-h-11 flex-col gap-1 rounded-xl border px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-60',
                    on ? 'border-foreground/40 bg-surface-2 dark:bg-accent' : 'border-border hover:bg-foreground/[0.025]',
                  )}
                >
                  <span className="text-[14px] font-semibold">{p.label}</span>
                  <span className="text-muted-foreground text-[12.5px] leading-snug">{p.sub}</span>
                </button>
              );
            })}
          </div>
          {order === 'stop-first' && one ? (
            <p className="text-tone-warn text-[13px]">{name} has one copy, so it is down for a moment on every deploy. Two copies, or starting new first, avoid that.</p>
          ) : null}
          <Tech>
            update_config order {order ?? 'stop-first'} · parallelism {spec ? parallelismOf(spec) : 1}
            {spec?.updateConfig?.order ? '' : ' (Docker default)'}
            {spec?.updateConfig?.failureAction ? ` · on failure ${spec.updateConfig.failureAction}` : ''} · services.update updateOrder
          </Tech>
        </>
      )}
    </Section>
  );
}
