import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheckIcon, ShieldXIcon, UserCheckIcon } from 'lucide-react';
import type { GuardrailDecisionView } from '@swarmy/core';
import { StatusBadge } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { relTime } from '@/lib/format';

function DecisionRow({ d }: { d: GuardrailDecisionView }): React.JSX.Element {
  const blocked = d.kind === 'blocked';
  return (
    <div className="space-y-1.5 px-5 py-3.5">
      <div className="flex items-start gap-2">
        {blocked ? (
          <ShieldXIcon className="text-status-offline mt-0.5 size-4 shrink-0" />
        ) : (
          <UserCheckIcon className="text-status-warning mt-0.5 size-4 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="mono-data text-sm font-semibold">{d.stack ?? 'a deploy'}</span>
            <StatusBadge tone={blocked ? 'offline' : 'warning'} label={d.kind} />
            <span className="text-muted-foreground text-xs">{relTime(d.at)}</span>
          </div>
          <p className="text-muted-foreground text-xs">
            {blocked ? 'Refused at the gate' : 'Pushed through with an override'}
            {d.actor ? ` — ${d.actor}` : ''}
          </p>
        </div>
      </div>
      {d.violations.length > 0 ? (
        <ul className="space-y-1 pl-6">
          {d.violations.slice(0, 4).map((v, i) => (
            <li key={i} className="text-xs">
              <span className="mono-data text-muted-foreground">[{v.severity}]</span> {v.message}
            </li>
          ))}
          {d.violations.length > 4 ? (
            <li className="text-muted-foreground text-xs">
              +{d.violations.length - 4} more violation{d.violations.length - 4 === 1 ? '' : 's'}
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

/** Recent blocked/overridden deploys — the audit-backed decisions feed. */
export function DecisionsFeed(): React.JSX.Element {
  const trpc = useTRPC();
  const decisions = useQuery({
    ...trpc.guardrails.recentDecisions.queryOptions({ limit: 30 }),
    refetchInterval: 15_000,
  });

  const rows = decisions.data ?? [];

  return (
    <section className="card-pop overflow-hidden">
      <header className="border-border flex items-center justify-between border-b px-5 py-3">
        <span className="mono-label !mb-0">Recent decisions</span>
        {rows.length > 0 ? (
          <span className="mono-data text-muted-foreground text-xs">{rows.length}</span>
        ) : null}
      </header>

      {decisions.isLoading ? (
        <div className="space-y-3 p-5">
          {[0, 1].map((i) => (
            <div key={i} className="shimmer-line h-12 rounded-lg" />
          ))}
        </div>
      ) : decisions.isError ? (
        <p className="text-muted-foreground px-5 py-4 text-sm">{decisions.error.message}</p>
      ) : rows.length === 0 ? (
        <div className="flex items-start gap-3 px-5 py-4">
          <ShieldCheckIcon className="text-status-online mt-0.5 size-4 shrink-0" />
          <p className="text-muted-foreground text-sm">
            Nothing blocked or overridden yet — deploys that hit a guardrail land here.
          </p>
        </div>
      ) : (
        <div className="divide-border divide-y">
          {rows.map((d) => (
            <DecisionRow key={d.id} d={d} />
          ))}
        </div>
      )}
    </section>
  );
}
