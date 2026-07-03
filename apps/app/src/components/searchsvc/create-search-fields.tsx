import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { SEARCH_ENGINES, type SearchEngine } from '@swarmy/core';
import {
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

export interface SearchDraft {
  stack: string;
  name: string;
  engine: SearchEngine;
  attachService: string;
}

export const EMPTY_SEARCH_DRAFT: SearchDraft = {
  stack: '',
  name: 'main',
  engine: 'meilisearch',
  attachService: '',
};

const ENGINE_HELP: Record<SearchEngine, string> = {
  meilisearch: 'Typo-tolerant instant search — the default for apps and docs.',
  typesense: 'Fast faceted search — keeps the whole index in memory.',
};

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="grid gap-1.5">
      <Label className="mono-label">{label}</Label>
      {children}
    </div>
  );
}

/** The create-search fields (stack / name / engine / attach). */
export function CreateSearchFields({
  draft,
  onChange,
  hideStack = false,
}: {
  draft: SearchDraft;
  onChange: (next: SearchDraft) => void;
  /** Hide the stack input when the stack comes from the workspace route. */
  hideStack?: boolean;
}): React.JSX.Element {
  const trpc = useTRPC();
  const services = useQuery(trpc.services.list.queryOptions({}));
  const set = (patch: Partial<SearchDraft>): void => onChange({ ...draft, ...patch });

  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-2 gap-3">
        {hideStack ? null : (
          <Field label="Stack">
            <Input value={draft.stack} onChange={(e) => set({ stack: e.target.value })} placeholder="shop" />
          </Field>
        )}
        <Field label="Instance name">
          <Input value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="main" />
        </Field>
      </div>
      <Field label="Engine">
        <Select value={draft.engine} onValueChange={(v) => set({ engine: v as SearchEngine })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {SEARCH_ENGINES.map((e) => (
              <SelectItem key={e} value={e}>
                {e === 'meilisearch' ? 'Meilisearch (default)' : 'Typesense'}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <p className="text-muted-foreground -mt-1 text-xs">
        {ENGINE_HELP[draft.engine]} Single-node v1 — it sizes with its node; data persists on a
        volume you can snapshot.
      </p>
      <Field label="Attach to service (optional)">
        <Select
          value={draft.attachService || 'none'}
          onValueChange={(v) => set({ attachService: v === 'none' ? '' : v })}
        >
          <SelectTrigger><SelectValue placeholder="No app yet" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No app yet</SelectItem>
            {(services.data ?? []).map((s) => (
              <SelectItem key={s.id} value={s.name}>{s.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </div>
  );
}
