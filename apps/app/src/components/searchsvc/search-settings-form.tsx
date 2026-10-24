import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { formatSynonyms, parseSynonyms, type SearchIndexSettingsView, type SearchSettingsResult } from '@swarmy/core';
import { Button, Input, Label, Textarea, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { fieldsWords, parseFields } from './search-words';

interface Props {
  s: SearchIndexSettingsView;
  onDone: () => void;
}

const same = (a: string[], b: string[]): boolean => a.join('\n') === b.join('\n');

function saved(r: SearchSettingsResult): string {
  if (r.status === 'succeeded') return `${r.index} is using the new settings`;
  return `Saved — Meilisearch is re-indexing ${r.index}; searches keep working meanwhile`;
}

/**
 * Edit what a search looks in, the filters and the synonyms of one index.
 * Only the lists you changed are sent; the engine re-indexes in the
 * background. Inline under the index, never a modal.
 */
export function SearchSettingsForm({ s, onDone }: Props): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const initial = React.useMemo(
    () => ({ searchable: fieldsWords(s.searchable).join(', '), filterable: s.filterable.join(', '), synonyms: formatSynonyms(s.synonyms) }),
    [s],
  );
  const [form, setForm] = React.useState(initial);
  const syn = parseSynonyms(form.synonyms);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });

  const save = useMutation(
    trpc.search.setIndexSettings.mutationOptions({
      onSuccess: (r) => {
        toast.success(saved(r));
        void qc.invalidateQueries({ queryKey: trpc.search.index.queryKey() });
        void qc.invalidateQueries({ queryKey: trpc.search.indexes.queryKey() });
        onDone();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!syn.ok) return;
    const searchable = parseFields(form.searchable);
    const filterable = parseFields(form.filterable);
    save.mutate({
      stack: s.stack,
      name: s.name,
      index: s.uid,
      ...(same(searchable, parseFields(initial.searchable)) ? {} : { searchable }),
      ...(same(filterable, s.filterable) ? {} : { filterable }),
      ...(form.synonyms.trim() === initial.synonyms.trim() ? {} : { synonyms: syn.map }),
    });
  };
  const dirty = form.searchable !== initial.searchable || form.filterable !== initial.filterable || form.synonyms !== initial.synonyms;
  const id = `search-${s.stack}-${s.name}-${s.uid}`;

  return (
    <form onSubmit={submit} className="bg-muted/40 flex flex-col gap-3 rounded-xl p-3.5" aria-label={`Settings for ${s.uid}`}>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-searchable`}>Searchable fields, most important first</Label>
        <Input id={`${id}-searchable`} value={form.searchable} onChange={set('searchable')} placeholder="Empty = every field" className="font-mono text-xs" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-filterable`}>Fields an app can filter by</Label>
        <Input id={`${id}-filterable`} value={form.filterable} onChange={set('filterable')} placeholder="category, price" className="font-mono text-xs" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-synonyms`}>Synonyms, one set per line</Label>
        <Textarea id={`${id}-synonyms`} value={form.synonyms} onChange={set('synonyms')} spellCheck={false} rows={5} disabled={s.synonymsTruncated} placeholder={'mug = cup\nphone -> smartphone'} className="font-mono text-xs" />
        <span className={syn.ok ? 'text-muted-foreground text-[12px]' : 'text-tone-bad text-[12px]'} role={syn.ok ? undefined : 'alert'}>
          {s.synonymsTruncated
            ? `${s.synonymWords} synonym words is more than swarmy shows — change them from your app`
            : syn.ok
              ? '`a = b, c` makes them all match each other · `a -> b` only widens a search for a'
              : `Line ${syn.line || '—'}: ${syn.reason}`}
        </span>
      </div>
      <p className="text-muted-foreground !mb-0 text-[12px]">
        Meilisearch re-indexes {s.uid} ({s.docs.toLocaleString()} documents) after a change; searches keep the old settings until it finishes.
      </p>
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" variant="outline" disabled={!dirty || !syn.ok || save.isPending}>
          {save.isPending ? 'Saving…' : 'Save settings'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
