import * as React from 'react';
import { SearchIcon } from 'lucide-react';
import type { BlueprintCategory } from '@swarmy/core';
import { Input, cn } from '@swarmy/ui';
import type { CategoryFilter } from './blueprint-filter';

interface BlueprintFilterBarProps {
  query: string;
  onQueryChange: (q: string) => void;
  category: CategoryFilter;
  onCategoryChange: (c: CategoryFilter) => void;
  categories: Array<{ id: BlueprintCategory; label: string; count: number }>;
  total: number;
}

/** Search box + category chips (with counts) above the Blueprints gallery. */
export function BlueprintFilterBar({
  query,
  onQueryChange,
  category,
  onCategoryChange,
  categories,
  total,
}: BlueprintFilterBarProps): React.JSX.Element {
  const chip = (id: CategoryFilter, label: string, count: number): React.JSX.Element => (
    <button
      key={id}
      type="button"
      aria-pressed={category === id}
      onClick={() => onCategoryChange(id)}
      className={cn(
        'rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
        category === id
          ? 'bg-ink text-ink-foreground'
          : 'bg-muted text-muted-foreground hover:bg-accent',
      )}
    >
      {label} <span className="mono-data opacity-70">{count}</span>
    </button>
  );
  return (
    <div className="mb-5 flex flex-col gap-3">
      <div className="relative max-w-md">
        <SearchIcon className="text-muted-foreground absolute left-3 top-1/2 size-3.5 -translate-y-1/2" />
        <Input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search apps: plausible, wiki, postgres…"
          aria-label="Search blueprints"
          className="h-9 rounded-full pl-8 text-sm"
        />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {chip('all', 'All', total)}
        {categories.map((c) => chip(c.id, c.label, c.count))}
      </div>
    </div>
  );
}
