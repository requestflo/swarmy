import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@swarmy/ui';
import { Section, Tech } from '@/components/calm';
import { envLabel, sha7 } from '@/components/gitops/plan-status';
import { ErrorState } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { RowsSkeleton } from '../tab-body';
import { PRECEDENCE, sharedCell, sharedHead, sharedSentence } from './shared-vars-model';

/**
 * Shared variables (boards Environments · AppVariables): what swarmy.yaml
 * sets for every environment and where each one overrides it — coral = an
 * override for that environment (`apps.envLayers`, read-only, secrets
 * masked). A stack no swarmy.yaml owns gets one plain sentence instead.
 */
export function SharedVariablesSection({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const q = useQuery({ ...trpc.apps.envLayers.queryOptions({ stack }), staleTime: 30_000 });
  const v = q.data;
  return (
    <Section title="Shared variables" count={v?.layers ? v.layers.rows.length : undefined} hint={<span className="font-mono">{PRECEDENCE}</span>}>
      {q.isError ? (
        <ErrorState title="Couldn't read swarmy.yaml's layers" error={q.error} retry={() => void q.refetch()} />
      ) : q.isPending ? (
        <RowsSkeleton />
      ) : v === null || v === undefined ? (
        <p className="text-muted-foreground text-[13.5px]">
          Environments come from swarmy.yaml. {stack} isn't deployed from a repo, so it has one set of variables — the list above.
        </p>
      ) : !v.layers ? (
        <p className="text-muted-foreground text-[13.5px]">{v.reason}</p>
      ) : (
        <>
          <p className="text-[13.5px]">{sharedSentence(v.layers)}</p>
          {v.layers.rows.length ? (
            // The table scrolls inside the card (relative: its sr-only notes stay inside too).
            <div className="relative w-0 min-w-full overflow-x-auto">
              <table className="w-full min-w-[32rem] border-collapse text-left text-[12.5px]">
                <thead>
                  <tr className="text-muted-foreground border-border border-b font-mono text-[11px] tracking-wide uppercase">
                    <th scope="col" className="py-2 pr-3 font-medium">Key</th>
                    <th scope="col" className="py-2 pr-3 font-medium">Shared · env:</th>
                    {v.layers.environments.map((e) => (
                      <th key={e} scope="col" className="py-2 pr-3 font-medium">
                        {envLabel(e)}
                        {v.dashboard.includes(e) ? <span className="text-tone-info ml-1 normal-case">· dashboard</span> : null}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {v.layers.rows.map((r) => {
                    const head = sharedHead(r.shared);
                    return (
                      <tr key={r.key} className="border-border border-b last:border-0 align-top">
                        <th scope="row" className="py-2 pr-3 font-mono font-semibold">{r.key}</th>
                        <td className={cn('py-2 pr-3 font-mono', head.masked && 'text-muted-foreground')}>{head.text}</td>
                        {v.layers!.environments.map((e) => {
                          const c = sharedCell(r.envs[e]);
                          return (
                            <td key={e} className="py-2 pr-3">
                              <span className={cn('font-mono [overflow-wrap:anywhere]', c.override ? 'text-primary font-semibold' : c.masked || c.text === '—' ? 'text-muted-foreground' : '')}>
                                {c.text}
                                {c.override ? <span className="sr-only"> (override)</span> : null}
                              </span>
                              {c.note ? <span className="text-muted-foreground block text-[11px]">{c.note}</span> : null}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
          <p className="text-muted-foreground text-xs">
            <span className="text-primary font-semibold">Coral</span> = an override for that environment. Secrets are never copied between environments; each has its own.
          </p>
          <Tech>{`${v.path} @ ${sha7(v.sha)} · ${v.environment}'s last planned commit · read only`}</Tech>
        </>
      )}
    </Section>
  );
}
