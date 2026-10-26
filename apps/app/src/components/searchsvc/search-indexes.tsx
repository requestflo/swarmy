import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SearchInstanceView } from '@swarmy/core';
import { Button, cn } from '@swarmy/ui';
import { Depth, Tech } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { Kv } from './search-kv';
import { SearchIndexDetail } from './search-index-detail';
import { SearchReindexDialog } from './search-reindex-dialog';
import { indexLine, reindexLine } from './search-words';

/**
 * The instance's indexes (board 41): each one's documents, size and last
 * change, read from the engine itself, then the picked index's settings. Not
 * polled — every read runs inside the engine and is audited — so it loads
 * when the block opens and on Refresh.
 */
export function SearchIndexes({ v }: { v: SearchInstanceView }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const live = v.engine === 'meilisearch' && v.running > 0;
  const q = useQuery({
    ...trpc.search.indexes.queryOptions({ stack: v.stack, name: v.name }),
    enabled: live,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const [picked, setPicked] = React.useState<string | null>(null);

  if (v.engine !== 'meilisearch') {
    return <Kv k="Indexes"><span className="text-muted-foreground text-[13px]">Typesense collections aren’t listed here yet.</span></Kv>;
  }
  if (!live) {
    return <Kv k="Indexes"><span className="text-muted-foreground text-[13px]">Its indexes show once it’s running.</span></Kv>;
  }
  if (q.isPending) {
    return (
      <Kv k="Indexes">
        <span aria-hidden className="shimmer-line h-4 w-2/3 rounded" />
      </Kv>
    );
  }
  if (q.error) {
    return (
      <Kv k="Indexes" action={<Button size="sm" variant="outline" onClick={() => void q.refetch()}>Try again</Button>}>
        <span className="text-tone-bad text-[13px]">Couldn’t read its indexes: {q.error.message}</span>
      </Kv>
    );
  }
  const list = q.data.indexes;
  if (list.length === 0) {
    return (
      <Kv k="Indexes">
        <span className="text-muted-foreground text-[13px]">No indexes yet — your app makes one the first time it adds documents.</span>
      </Kv>
    );
  }
  const current = list.find((i) => i.uid === picked) ?? list[0]!;
  return (
    <div className="flex flex-col">
      {list.length > 1 ? (
        <div role="group" aria-label="Indexes" className="flex flex-wrap gap-1.5 pb-2.5">
          {list.map((ix) => (
            <button
              key={ix.uid}
              type="button"
              aria-pressed={ix.uid === current.uid}
              onClick={() => setPicked(ix.uid)}
              className={cn(
                'pointer-coarse:min-h-11 rounded-full border px-2.5 py-1 font-mono text-[11.5px]',
                ix.uid === current.uid ? 'border-foreground/40 bg-muted font-semibold' : 'border-border text-muted-foreground',
              )}
            >
              {ix.uid}
            </button>
          ))}
        </div>
      ) : null}
      <Kv
        k={current.uid}
        tech={`GET /indexes · GET /stats — Meilisearch API, called inside ${v.service}${q.data.truncated ? ` · first ${list.length} of ${q.data.total}` : ''}`}
        action={
          <Button
            size="sm"
            variant="ghost"
            disabled={q.isFetching}
            onClick={() => {
              void q.refetch();
              void qc.invalidateQueries({ queryKey: trpc.search.index.queryKey() });
            }}
          >
            Refresh
          </Button>
        }
      >
        <span className="text-[13px] font-semibold">{indexLine(current)}</span>
      </Kv>
      <SearchIndexDetail key={current.uid} v={v} uid={current.uid} />
      {current.primaryKey ? <Tech className="pt-1 pb-2">primary key {current.primaryKey}</Tech> : null}
      <Kv
        k="Reindex"
        tech="POST /swap-indexes · the engine swaps both at once; the old documents keep the other name"
        action={
          <Depth at="controls">
            <SearchReindexDialog key={current.uid} v={v} live={current} indexes={list} onSwapped={setPicked} />
          </Depth>
        }
      >
        <span className="text-[13px]">{reindexLine(v, current.uid)}</span>
      </Kv>
    </div>
  );
}
