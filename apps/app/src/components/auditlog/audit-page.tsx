import * as React from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { AuditFilterInput } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { AuditFilters, EMPTY_FILTERS, type AuditFilterState } from './audit-filters';
import { AuditTable } from './audit-table';
import { CannedChips } from './canned-chips';
import { CANNED_QUESTIONS } from './canned-questions';
import { ExportButtons } from './export-buttons';
import { RetentionCard } from './retention-card';

const PAGE_SIZE = 50;

/**
 * Governance → Audit: the org's full action trail. Canned compliance questions
 * as one-tap chips, a filter bar over live facets, a cursor-paginated timeline
 * with a per-row detail drawer, CSV/JSON export and the retention setting.
 */
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
  const list = useInfiniteQuery({
    ...trpc.audit.list.infiniteQueryOptions(
      { ...filterInput, limit: PAGE_SIZE },
      { getNextPageParam: (last) => last.nextCursor },
    ),
    refetchInterval: 30_000,
  });

  const entries = React.useMemo(
    () => list.data?.pages.flatMap((p) => p.entries) ?? [],
    [list.data],
  );
  const activeCanned = CANNED_QUESTIONS.find((q) => q.key === filters.canned) ?? null;

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Governance · Audit"
        title={
          <>
            Who did <em>what</em>, when.
          </>
        }
        description="Every action across the org — people, API keys, agents and swarmy itself — recorded the moment it happens. Filter it, answer the classic questions in one tap, export it for the auditors."
        actions={<ExportButtons filters={filterInput} />}
      />

      <div className="space-y-4">
        <CannedChips
          active={filters.canned}
          onPick={(key) => setFilters({ ...EMPTY_FILTERS, canned: key })}
        />
        {activeCanned ? (
          <p className="text-muted-foreground text-sm">
            Showing: <span className="text-foreground font-medium">{activeCanned.hint}</span>
          </p>
        ) : null}
        <AuditFilters facets={facets.data} value={filters} onChange={setFilters} />

        <div className="grid items-start gap-6 xl:grid-cols-[1fr_20rem]">
          <AuditTable
            entries={entries}
            isLoading={list.isLoading}
            isError={list.isError}
            errorMessage={list.error?.message}
            hasNextPage={list.hasNextPage}
            isFetchingNextPage={list.isFetchingNextPage}
            onLoadMore={() => void list.fetchNextPage()}
            onRetry={() => void list.refetch()}
          />
          <div className="space-y-6">
            <RetentionCard />
            <div className="card-pop p-5">
              <h3 className="font-display text-base font-bold">Pull it via API</h3>
              <p className="text-muted-foreground mt-1 text-sm">
                Compliance tooling can fetch the same export with an org API key:
              </p>
              <pre className="mono-data bg-accent mt-3 overflow-x-auto rounded-lg p-3 text-xs">
                GET /api/v1/audit/export?format=csv
              </pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
