import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { SearchIcon } from 'lucide-react';
import type { BlueprintCategory, BlueprintMetaView } from '@swarmy/core';
import { Button, Input } from '@swarmy/ui';
import { FilterChip } from '@/components/blueprints/filter-chip';
import { matchesQuery } from '@/components/blueprints/blueprint-filter';
import { TemplateGrid } from '@/components/blueprints/template-grid';

/** The hub's plain-words shelves (the Templates page has every category). */
const SHELVES: { id: BlueprintCategory; label: string }[] = [
  { id: 'cms', label: 'Websites' },
  { id: 'data', label: 'Data' },
  { id: 'ai', label: 'AI' },
  { id: 'automation', label: 'Automation' },
  { id: 'devtools', label: 'Dev tools' },
];

/** Shown first when nothing is filtered: well-known apps across the shelves. */
const POPULAR = ['ghost', 'wordpress', 'plausible', 'n8n', 'umami', 'uptime-kuma', 'open-webui', 'gitea', 'directus', 'metabase', 'flowise', 'vaultwarden'];
const SHOWN = 12;

function popularFirst(a: BlueprintMetaView, b: BlueprintMetaView): number {
  const ia = POPULAR.indexOf(a.id);
  const ib = POPULAR.indexOf(b.id);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
}

/** Under the Template card: browse-all, search, shelves, the count and twelve cards. */
export function TemplateShelf({
  all,
  pending,
  selected,
  onPick,
}: {
  all: BlueprintMetaView[];
  pending: boolean;
  selected: string | null;
  onPick: (id: string) => void;
}): React.JSX.Element {
  const [query, setQuery] = React.useState('');
  const [shelf, setShelf] = React.useState<BlueprintCategory | 'all'>('all');
  const matching = all.filter((m) => (shelf === 'all' || m.category === shelf) && matchesQuery(m, query)).sort(popularFirst);
  const shown = matching.slice(0, SHOWN);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild variant="outline" size="sm" className="pointer-coarse:min-h-11">
          <Link to="/blueprints">Browse all {pending ? '' : `${all.length} `}templates</Link>
        </Button>
        <div className="relative min-w-0 flex-1 basis-56 sm:max-w-xs">
          <SearchIcon aria-hidden className="text-muted-foreground absolute top-1/2 left-3 size-3.5 -translate-y-1/2" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search templates" aria-label="Search templates" className="h-9 rounded-xl pl-8 text-sm" />
        </div>
        <div role="group" aria-label="Kinds of app" className="flex flex-wrap gap-1.5">
          <FilterChip selected={shelf === 'all'} onClick={() => setShelf('all')}>All</FilterChip>
          {SHELVES.map((s) => (
            <FilterChip key={s.id} selected={shelf === s.id} onClick={() => setShelf(s.id)}>
              {s.label}
            </FilterChip>
          ))}
        </div>
        {pending ? null : (
          <span className="text-muted-foreground ml-auto font-mono text-[11.5px]">
            {shown.length} of {matching.length} templates
          </span>
        )}
      </div>
      {pending ? (
        <TemplateGrid.Skeleton count={SHOWN} />
      ) : shown.length === 0 ? (
        <p className="calm-card text-muted-foreground px-5 py-6 text-sm">
          Nothing here matches. <Link to="/blueprints" className="text-primary font-semibold hover:underline">See every template</Link>, or bring your own code above.
        </p>
      ) : (
        <TemplateGrid cards={shown} selected={selected} onPick={onPick} variant="hub" />
      )}
    </div>
  );
}
