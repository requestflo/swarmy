import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { StatusWord, Section, Tech } from '@/components/calm';
import { relTime } from '@/lib/format';

/** Recent blocked and overridden deploys, from the audit log. */
export function DecisionsFeed(): React.JSX.Element {
  const trpc = useTRPC();
  const decisions = useQuery({ ...trpc.guardrails.recentDecisions.queryOptions({ limit: 30 }), refetchInterval: 15_000 });
  const rows = decisions.data ?? [];
  return (
    <Section title="Recent decisions" count={rows.length || undefined} flush>
      {decisions.isLoading ? (
        <div aria-hidden className="shimmer-line my-3 h-10 rounded-lg" />
      ) : decisions.isError ? (
        <p className="text-muted-foreground py-4 text-sm">{decisions.error.message}</p>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground py-4 text-sm">Nothing blocked or overridden yet. Deploys that hit a guardrail land here.</p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((d) => (
            <li key={d.id} className="border-border flex flex-col gap-1 border-b py-2.5 last:border-b-0">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">{d.stack ?? 'a deploy'}</span>
                <StatusWord tone={d.kind === 'blocked' ? 'bad' : 'warn'} word={d.kind === 'blocked' ? 'Stopped' : 'Overridden'} />
              </div>
              <p className="text-muted-foreground text-[13px] leading-snug">{d.violations[0]?.message ?? 'Hit a guardrail.'}</p>
              <span className="text-muted-foreground text-xs">{relTime(d.at)}{d.actor ? ` · ${d.actor}` : ''}</span>
              <Tech>{d.violations.map((v) => `${v.rule}:${v.severity}`).join(' · ')}</Tech>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
