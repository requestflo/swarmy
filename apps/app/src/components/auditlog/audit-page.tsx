import * as React from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { AuditFilterInput } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { CodeView, Depth } from '@/components/calm';
import { RowPage, plural } from '@/components/rowpage/row-page';
import { AuditFilters, EMPTY_FILTERS, type AuditFilterState } from './audit-filters';
import { auditCode } from './audit-code';
import { AuditTable } from './audit-table';
import { CannedChips } from './canned-chips';
import { CANNED_QUESTIONS } from './canned-questions';
import { ExportButtons } from './export-buttons';
import { RetentionCard } from './retention-card';

const PAGE_SIZE = 50;

/** Activity → Audit log: who did what, when. One-tap questions, filters at Controls, the export as REST at Code. */
export function AuditPage(): React.JSX.Element {
  const trpc = useTRPC();
  const [filters, setFilters] = React.useState<AuditFilterState>(EMPTY_FILTERS);
  const filterInput = React.useMemo<AuditFilterInput>(() => {
    const canned = CANNED_QUESTIONS.find((q) => q.key === filters.canned);
    return {
      actor: filters.actor ?? undefined,
      actorType: filters.actorType ?? undefined,
      action: filters.action ?? undefined,
      actions: canned?.actions,
      from: filters.from || undefined,
      to: filters.to || undefined,
    };
  }, [filters]);
  const facets = useQuery(trpc.audit.facets.queryOptions());
  const retention = useQuery(trpc.audit.retention.queryOptions());
  const list = useInfiniteQuery({
    ...trpc.audit.list.infiniteQueryOptions({ ...filterInput, limit: PAGE_SIZE }, { getNextPageParam: (last) => last.nextCursor }),
    refetchInterval: 30_000,
  });
  const entries = React.useMemo(() => list.data?.pages.flatMap((p) => p.entries) ?? [], [list.data]);
  const activeCanned = CANNED_QUESTIONS.find((q) => q.key === filters.canned) ?? null;

  const week = entries.filter((e) => Date.now() - new Date(e.ts).getTime() < 7 * 86_400_000);
  const people = new Set(week.filter((e) => e.actorType === 'user').map((e) => e.actorId)).size;
  const robots = new Set(week.filter((e) => e.actorType === 'apikey').map((e) => e.actorId)).size;
  const title = list.isLoading ? (
    'Who did what, when.'
  ) : (
    <>
      {plural(week.length, 'change')}{list.hasNextPage && week.length === entries.length ? '+' : ''} this week{filters.canned || filters.actor || filters.action ? ' match' : ''}.{' '}
      <em>
        By {plural(people, 'person', 'people')}, {plural(robots, 'key')} and swarmy.
      </em>
    </>
  );
  const lede = `Every action by people, API keys, servers and swarmy itself, recorded the moment it happens${retention.data ? ` and kept for ${retention.data.days} days` : ''}.`;

  return (
    <RowPage
      title={title}
      description={lede}
      actions={<ExportButtons filters={filterInput} />}
      aside={
        <>
          <CodeView title="The audit log over REST" tabs={auditCode(filterInput, entries)} note="An org API key can pull the same export. Canned questions filter in the dashboard; over REST pass action= and the dates." />
          <RetentionCard />
        </>
      }
    >
      <AuditTable
        entries={entries}
        isLoading={list.isLoading}
        isError={list.isError}
        errorMessage={list.error?.message}
        hasNextPage={list.hasNextPage}
        isFetchingNextPage={list.isFetchingNextPage}
        onLoadMore={() => void list.fetchNextPage()}
        onRetry={() => void list.refetch()}
        toolbar={
          <>
            <CannedChips active={filters.canned} onPick={(key) => setFilters({ ...EMPTY_FILTERS, canned: key })} />
            {activeCanned ? <p className="text-muted-foreground text-sm">Showing: <span className="text-foreground font-medium">{activeCanned.hint}</span></p> : null}
            <Depth at="controls">
              <AuditFilters facets={facets.data} value={filters} onChange={setFilters} />
            </Depth>
          </>
        }
      />
    </RowPage>
  );
}
