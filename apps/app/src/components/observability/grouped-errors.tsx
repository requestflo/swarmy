import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@swarmy/ui';
import { Section, Tech } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { lineTime, matchIssue, type ErrorGroup, type IssueLike } from './stream-model';

const hhmm = (nano: string): string => lineTime(nano).slice(0, 5);

/**
 * "Grouped errors": the stream's error lines grouped by message fingerprint,
 * with a count, first and last seen and the part. A click filters the stream
 * to that group; when error tracking has the same issue, it links there.
 */
export function GroupedErrors({ stack, groups, active, onPick }: { stack: string; groups: ErrorGroup[]; active: string | null; onPick: (key: string | null) => void }): React.JSX.Element {
  const trpc = useTRPC();
  const issues = useQuery({ ...trpc.errors.issues.queryOptions({ stack, status: 'unresolved', limit: 100 }), refetchInterval: 30_000 });
  const list = issues.data?.status === 'ok' ? (issues.data.issues as IssueLike[]) : [];

  return (
    <Section title="Grouped errors" count={groups.length > 0 ? groups.length : undefined} flush>
      {groups.length === 0 ? (
        <p className="text-muted-foreground pb-3 text-[14px]">No errors in these lines. Repeats would group here, with a count.</p>
      ) : (
        <ul className="flex flex-col gap-2 pb-3">
          {groups.map((g) => {
            const issue = matchIssue(g, list);
            const on = active === g.key;
            return (
              <li key={g.key} className={cn('border-border rounded-[12px] border', on && 'border-foreground/30 bg-accent/40')}>
                <button type="button" aria-pressed={on} onClick={() => onPick(on ? null : g.key)} className="hover:bg-accent/40 flex w-full min-w-0 flex-col gap-1 rounded-[12px] px-3 py-2.5 text-left pointer-coarse:min-h-11">
                  <span className="flex flex-wrap items-baseline gap-x-2 font-mono text-[12px]">
                    <span className="text-tone-bad font-bold">{g.count}×</span>
                    <span>{g.part}</span>
                    <span className="text-muted-foreground">
                      {g.count > 1 ? `${hhmm(g.firstNano)}–${hhmm(g.lastNano)}` : `at ${hhmm(g.lastNano)}`}
                    </span>
                  </span>
                  <span className="text-[13.5px] break-words">{g.message}</span>
                  <span className="text-muted-foreground text-xs">{on ? 'Showing only these. Click again for every line.' : 'Show only these lines'}</span>
                </button>
                {issue ? (
                  <Link to="/stacks/$name/errors/$fingerprint" params={{ name: stack, fingerprint: issue }} className="border-border text-foreground flex min-h-10 items-center border-t px-3 text-[13px] font-semibold underline-offset-2 hover:underline pointer-coarse:min-h-11">
                    Error tracking has this one →
                  </Link>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <Tech className="pb-3">grouped by part + message with ids and numbers masked · error tracking matched on the call name</Tech>
    </Section>
  );
}
