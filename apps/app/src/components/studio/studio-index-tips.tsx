import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { CopyButton } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { CardSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import type { StudioScope } from './studio-types';

/**
 * Index suggestions for a Postgres database (`studio.indexAdvice`, board
 * 63): unindexed foreign keys, big tables read start to finish, unused
 * indexes — each with the reason in plain words and SQL to copy. swarmy
 * never runs them; CONCURRENTLY can take minutes, so they belong in psql.
 */
export function StudioIndexTips({ scope }: { scope: StudioScope }): React.JSX.Element | null {
  const trpc = useTRPC();
  const q = useQuery({
    ...trpc.studio.indexAdvice.queryOptions({ stack: scope.stack, target: scope.target.name, database: scope.database }),
    staleTime: 5 * 60_000,
    retry: false,
  });
  if (q.isPending) return <CardSkeleton />;
  if (q.isError) return <p className="text-muted-foreground text-sm">Index suggestions are unavailable just now: {q.error.message}</p>;
  const d = q.data;
  if (d.unavailable) return null;
  const since = d.statsSince ? `since ${d.statsSince.slice(0, 10)}` : 'since its statistics began';
  return (
    <section aria-label="Index suggestions" className="space-y-2">
      <p className="text-sm">
        <span className="font-semibold">{d.tips.length ? `${d.tips.length} index suggestion${d.tips.length === 1 ? '' : 's'}` : 'No index suggestions'}</span>
        <span className="text-muted-foreground">
          {' '}
          · from {d.database ?? 'this database'}’s own counts {since}
          {d.tips.length ? '' : `: nothing stood out across ${d.checked.tables} tables and ${d.checked.indexes} indexes`}
        </span>
      </p>
      {d.tips.map((t) => (
        <div key={`${t.kind}:${t.sql}`} className="calm-card space-y-2 border-0 p-3 shadow-none">
          <p className="text-sm">
            <span className="font-semibold">{t.head}</span>
            <span className="text-muted-foreground"> · {t.gain}</span>
          </p>
          <p className="text-muted-foreground text-[13px] leading-relaxed">{t.why}</p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="calm-code min-w-0 flex-1 truncate px-3 py-2 text-[11.5px]" title={t.sql}>
              {t.sql}
            </code>
            <CopyButton value={t.sql} label={t.sqlKind === 'template' ? 'Copy template' : 'Copy SQL'} className="pointer-coarse:min-h-11" />
          </div>
          <Tech>{t.facts}</Tech>
        </div>
      ))}
      {d.tips.length ? (
        <p className="text-muted-foreground text-xs">
          swarmy never runs these. CONCURRENTLY keeps the table writable while it builds, but it can take minutes on a big table and can’t run
          inside a transaction: run it from psql. If it is stopped part-way, drop the INVALID index it leaves and run it again.
        </p>
      ) : null}
      <Tech>
        studio.indexAdvice · one read of pg_stat_user_tables, pg_stat_user_indexes and pg_constraint, audited as studio.query (origin indexes)
        {d.standbys ? ` · ${d.standbys} standby cop${d.standbys === 1 ? 'y keeps its' : 'ies keep their'} own counts` : ''}
      </Tech>
    </section>
  );
}
