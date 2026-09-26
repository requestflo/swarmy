import * as React from 'react';
import { SearchIcon } from 'lucide-react';
import type { BlueprintCategory } from '@swarmy/core';
import { Input, Switch } from '@swarmy/ui';
import { LIGHT_MB, type CategoryFilter, type TemplateToggles } from './blueprint-filter';
import { FilterChip } from './filter-chip';

const TRY = ['analytics', 'chat', 'postgres'];
const TOGGLES: { key: keyof TemplateToggles; label: string }[] = [
  { key: 'small', label: 'Fits a 1 GB server' },
  { key: 'postgres', label: 'Uses managed Postgres' },
  { key: 'light', label: `Lightweight (≤ ${LIGHT_MB} MB)` },
];

interface BlueprintFilterBarProps {
  query: string;
  onQueryChange: (q: string) => void;
  category: CategoryFilter;
  onCategoryChange: (c: CategoryFilter) => void;
  categories: Array<{ id: BlueprintCategory; label: string; count: number }>;
  toggles: TemplateToggles;
  onTogglesChange: (t: TemplateToggles) => void;
  /** Templates matching the search + toggles (the "All" count). */
  matching: number;
  showing: number;
  total: number;
}

/** Search (with "Try:" suggestions), category chips with counts, three quick toggles and the count line. */
export function BlueprintFilterBar(p: BlueprintFilterBarProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-64 sm:max-w-md">
          <SearchIcon aria-hidden className="text-muted-foreground absolute top-1/2 left-3 size-3.5 -translate-y-1/2" />
          <Input
            value={p.query}
            onChange={(e) => p.onQueryChange(e.target.value)}
            placeholder={`Search ${p.total} apps…`}
            aria-label="Search templates"
            className="h-10 rounded-xl pl-8 text-sm"
          />
        </div>
        <span className="text-muted-foreground text-[12.5px]">Try</span>
        {TRY.map((t) => (
          <FilterChip key={t} selected={p.query === t} onClick={() => p.onQueryChange(p.query === t ? '' : t)}>
            {t}
          </FilterChip>
        ))}
      </div>
      <div role="group" aria-label="Categories" className="flex flex-wrap items-center gap-1.5">
        <FilterChip selected={p.category === 'all'} onClick={() => p.onCategoryChange('all')} count={p.matching}>
          All
        </FilterChip>
        {p.categories.map((c) => (
          <FilterChip key={c.id} selected={p.category === c.id} onClick={() => p.onCategoryChange(c.id)} count={c.count}>
            {c.label}
          </FilterChip>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        {TOGGLES.map((t) => (
          <label key={t.key} className="flex min-h-9 cursor-pointer items-center gap-2 text-[13px] pointer-coarse:min-h-11">
            <Switch checked={Boolean(p.toggles[t.key])} onCheckedChange={(v) => p.onTogglesChange({ ...p.toggles, [t.key]: v })} />
            {t.label}
          </label>
        ))}
        <span className="text-muted-foreground ml-auto font-mono text-[11.5px]">
          Showing {p.showing} of {p.total}
        </span>
      </div>
    </div>
  );
}
