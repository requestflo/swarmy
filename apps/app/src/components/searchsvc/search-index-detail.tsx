import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { synonymLines, type SearchInstanceView } from '@swarmy/core';
import { Button } from '@swarmy/ui';
import { Depth } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { FieldChips, Kv } from './search-kv';
import { SearchSettingsForm } from './search-settings-form';
import { SearchTryIt } from './search-try-it';
import { fieldsWords, synonymsLine } from './search-words';

/**
 * One index's settings as board 41 lays them out: what a search looks in
 * (searchable), what an app can narrow by (filters) and the words that count
 * as the same (synonyms) — read from the engine, never from swarmy.
 */
export function SearchIndexDetail({ v, uid }: { v: SearchInstanceView; uid: string }): React.JSX.Element {
  const trpc = useTRPC();
  const [editing, setEditing] = React.useState(false);
  const q = useQuery({
    ...trpc.search.index.queryOptions({ stack: v.stack, name: v.name, index: uid }),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  if (q.isPending) {
    return (
      <Kv k="Settings">
        <span aria-hidden className="shimmer-line h-4 w-1/2 rounded" />
      </Kv>
    );
  }
  if (q.error) {
    return (
      <Kv k="Settings">
        <span className="text-tone-bad text-[13px]">Couldn’t read {uid}’s settings: {q.error.message}</span>
      </Kv>
    );
  }
  const s = q.data;
  const edit = (
    <Depth at="controls">
      <Button size="sm" variant="ghost" aria-expanded={editing} onClick={() => setEditing(!editing)}>
        {editing ? 'Close' : 'Edit'}
      </Button>
    </Depth>
  );
  return (
    <>
      <Kv k="Searchable" tech={`searchableAttributes · ${s.searchable.join(', ')}`} action={edit}>
        <FieldChips fields={fieldsWords(s.searchable)} empty="Every field, in the order documents have them" />
      </Kv>
      <Kv k="Filters" tech={`filterableAttributes${s.sortable.length ? ` · sortable ${s.sortable.join(', ')}` : ''}`}>
        <FieldChips fields={s.filterable} empty="None yet — an app can’t narrow results by a field" />
      </Kv>
      <Kv k="Synonyms" tech={`synonyms · ${s.synonymWords} words${s.synonymsTruncated ? ' (first 200 shown)' : ''}`}>
        <span className="text-[13px]">{synonymsLine(s.synonyms, s.synonymWords)}</span>
      </Kv>
      {editing ? <SearchSettingsForm key={uid} s={s} onDone={() => setEditing(false)} /> : null}
      <SearchTryIt key={uid} v={v} uid={uid} suggestions={synonymLines(s.synonyms).slice(0, 3).map((l) => l.words[0]!)} />
    </>
  );
}
