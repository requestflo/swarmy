import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { SearchIcon } from 'lucide-react';
import { MAX_SEARCH_QUERY, type SearchInstanceView } from '@swarmy/core';
import { Button, Input } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { Kv } from './search-kv';
import { queryMeta, scoreWord } from './search-words';

interface Props {
  v: SearchInstanceView;
  uid: string;
  /** Words worth trying (from the index's own synonyms). */
  suggestions: string[];
}

/**
 * "Try it" (board 41): search the index the way the app does and see the
 * top 5 hits with how long the engine took. Runs only when asked — each
 * search is a policy-checked, audited read of the app's documents.
 */
export function SearchTryIt({ v, uid, suggestions }: Props): React.JSX.Element {
  const trpc = useTRPC();
  const [text, setText] = React.useState('');
  const [q, setQ] = React.useState<string | null>(null);
  const res = useQuery({
    ...trpc.search.query.queryOptions({ stack: v.stack, name: v.name, index: uid, q: q ?? '' }),
    enabled: q !== null,
    staleTime: 30_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const run = (value: string): void => {
    setText(value);
    setQ(value.trim());
  };
  return (
    <Kv k="Try it" tech={`POST /indexes/${uid}/search · limit 5 · inside ${v.service}`}>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          run(text);
        }}
      >
        <Input
          value={text}
          maxLength={MAX_SEARCH_QUERY}
          onChange={(e) => setText(e.target.value)}
          placeholder={`Search ${uid}`}
          aria-label={`Search ${uid}`}
          className="h-9 flex-1"
        />
        <Button type="submit" size="sm" variant="outline" disabled={res.isFetching}>
          <SearchIcon className="size-3.5" /> Search
        </Button>
      </form>
      {q === null && suggestions.length ? (
        <span className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
          <span className="text-muted-foreground">Try</span>
          {suggestions.map((w) => (
            <button key={w} type="button" onClick={() => run(w)} className="bg-muted pointer-coarse:min-h-11 rounded-full px-2.5 py-0.5 font-mono text-[11.5px]">
              {w}
            </button>
          ))}
        </span>
      ) : null}
      {res.isFetching && !res.data ? <span aria-hidden className="shimmer-line h-4 w-1/2 rounded" /> : null}
      {res.error ? <span role="alert" className="text-tone-bad text-[13px]">{res.error.message}</span> : null}
      {res.data ? (
        <div className="flex flex-col gap-1.5" aria-live="polite">
          <ol className="divide-border flex flex-col divide-y">
            {res.data.hits.map((h, n) => (
              <li key={h.id ?? n} className="flex items-baseline gap-3 py-1.5">
                <span className="text-muted-foreground w-9 shrink-0 font-mono text-[11.5px]">{scoreWord(h.score)}</span>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[13px] font-semibold">{h.title}</span>
                  {h.meta ? <span className="text-muted-foreground truncate text-[12px]">{h.meta}</span> : null}
                </span>
              </li>
            ))}
          </ol>
          <span className="text-muted-foreground font-mono text-[11.5px]">{queryMeta(res.data)}</span>
          <Tech>score = _rankingScore · ids {res.data.hits.map((h) => h.id ?? '—').join(', ') || 'none'}</Tech>
        </div>
      ) : null}
    </Kv>
  );
}
