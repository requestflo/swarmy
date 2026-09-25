import * as React from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeftIcon, ChevronRightIcon, PlusIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CardSkeleton, ErrorState } from '@/components/states';
import { StudioResultTable } from './studio-result-table';
import { StudioFilterBar, StudioMongoFilter } from './studio-filter-bar';
import { StudioRowEditor } from './studio-row-editor';
import { StudioDocEditor } from './studio-doc-editor';
import type { StudioFilter, StudioScope, StudioTableView } from './studio-types';

const PAGE = 50;

/** The table/collection grid: filters, sort by header, pagination, and the row/document editor. */
export function StudioData({ scope, table }: { scope: StudioScope; table: StudioTableView }): React.JSX.Element {
  const trpc = useTRPC();
  const mongo = scope.target.engine === 'mongo';
  const [page, setPage] = React.useState(0);
  const [sort, setSort] = React.useState<{ col: string; dir: 'asc' | 'desc' } | null>(null);
  const [filters, setFilters] = React.useState<StudioFilter[]>([]);
  const [mongoFilter, setMongoFilter] = React.useState('');
  const [sel, setSel] = React.useState<number | 'new' | null>(null);
  React.useEffect(() => {
    setPage(0);
    setSort(null);
    setFilters([]);
    setMongoFilter('');
    setSel(null);
  }, [table.name, table.schema]);

  const coll = useQuery({ ...trpc.studio.collection.queryOptions({ stack: scope.stack, target: scope.target.name, database: scope.database, collection: table.name }), enabled: mongo });
  const meta = mongo ? coll.data : table;
  const orderBy = sort?.col ?? (table.keyColumns[0] ?? null);
  const q = useQuery({
    ...trpc.studio.browse.queryOptions({
      stack: scope.stack, target: scope.target.name, database: scope.database, table: { schema: table.schema, name: table.name },
      page, pageSize: PAGE, orderBy, dir: sort?.dir ?? 'desc',
      ...(mongo ? { mongoFilter } : { filters }),
    }),
    placeholderData: keepPreviousData,
  });

  const columns = q.data?.columns.length ? q.data.columns : (meta?.columns ?? []).map((c) => c.name);
  const types = Object.fromEntries((meta?.columns ?? []).map((c) => [c.name, c.type]));
  const dir = sort?.dir ?? 'desc';
  const sortLine = orderBy ? `sort ${orderBy} ${dir === 'asc' ? '↑' : '↓'} · click a header to sort` : 'server order';
  const onSort = (c: string) => { setPage(0); setSort({ col: c, dir: sort?.col === c && sort.dir === 'asc' ? 'desc' : 'asc' }); };
  const applied = () => { setSel(null); void q.refetch(); };
  const row = typeof sel === 'number' ? q.data?.rows[sel] ?? null : null;
  const doc = typeof sel === 'number' ? ((q.data?.documents?.[sel] as Record<string, unknown> | undefined) ?? null) : null;

  return (
    <div className="bg-card calm-card shadow-none flex min-h-[28rem] flex-1 flex-col overflow-hidden border-0 lg:flex-row">
      <div className="flex min-w-0 flex-1 flex-col">
        {mongo ? (
          <StudioMongoFilter value={mongoFilter} onApply={(v) => { setPage(0); setMongoFilter(v); }} sortLine={sortLine} />
        ) : (
          <StudioFilterBar columns={columns} filters={filters} onChange={(f) => { setPage(0); setFilters(f); }} sortLine={sortLine} />
        )}
        {q.isPending ? <CardSkeleton /> : q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : (
          <StudioResultTable columns={columns} rows={q.data.rows} types={types} keys={table.keyColumns} sort={orderBy ? { col: orderBy, dir } : null} onSort={onSort} selected={typeof sel === 'number' ? sel : null} onSelect={setSel} className="flex-1" />
        )}
        <div className="border-border bg-card flex items-center gap-2 border-t px-3 py-1.5">
          <span className="text-muted-foreground font-mono text-[11px]">
            {q.data ? `${page * PAGE + (q.data.rows.length ? 1 : 0)}–${page * PAGE + q.data.rows.length}${table.rowsEstimate != null ? ` of ~${table.rowsEstimate.toLocaleString()}` : ''} · ${q.data.durationMs} ms` : ''}
          </span>
          <div className="flex-1" />
          <Button size="sm" variant="ghost" onClick={() => setSel('new')} disabled={!mongo && table.keyColumns.length === 0}><PlusIcon className="size-3.5" /> {mongo ? 'Document' : 'Row'}</Button>
          <Button size="icon" variant="ghost" aria-label="Previous page" disabled={page === 0} onClick={() => setPage(page - 1)}><ChevronLeftIcon className="size-4" /></Button>
          <span className="font-mono text-[11px]">page {page + 1}</span>
          <Button size="icon" variant="ghost" aria-label="Next page" disabled={!q.data?.hasMore} onClick={() => setPage(page + 1)}><ChevronRightIcon className="size-4" /></Button>
        </div>
      </div>
      {sel !== null ? (
        mongo ? (
          <StudioDocEditor scope={scope} collection={table.name} doc={sel === 'new' ? null : doc} onClose={() => setSel(null)} onApplied={applied} />
        ) : (
          <StudioRowEditor scope={scope} table={table} columns={columns} row={sel === 'new' ? null : row} onClose={() => setSel(null)} onApplied={applied} />
        )
      ) : null}
    </div>
  );
}
