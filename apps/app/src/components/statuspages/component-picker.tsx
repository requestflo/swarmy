import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckIcon } from 'lucide-react';
import type { StatusComponentOption, StatusPageComponent } from '@swarmy/core';
import { Skeleton, cn } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

const KIND_ORDER = ['service', 'db', 'cache', 'region', 'ingress'] as const;
const KIND_TITLE: Record<(typeof KIND_ORDER)[number], string> = {
  service: 'Services',
  db: 'Databases',
  cache: 'Caches',
  region: 'Regions',
  ingress: 'Ingress',
};

/** A stable per-page key for a picked option (unique among `taken`). */
function keyFor(option: StatusComponentOption, taken: Set<string>): string {
  const base = option.ref
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || option.kind;
  return taken.has(base) ? `${option.kind}-${base}` : base;
}

/**
 * Pick what the page watches — live services, managed db/cache clusters,
 * regions and the ingress edge, straight from the inventory.
 */
export function ComponentPicker({
  selected,
  onChange,
}: {
  selected: StatusPageComponent[];
  onChange: (next: StatusPageComponent[]) => void;
}): React.JSX.Element {
  const trpc = useTRPC();
  const options = useQuery(trpc.statusPages.componentOptions.queryOptions());

  const isPicked = (o: StatusComponentOption): boolean =>
    selected.some((c) => c.kind === o.kind && c.ref === o.ref);

  const toggle = (o: StatusComponentOption): void => {
    if (isPicked(o)) {
      onChange(selected.filter((c) => !(c.kind === o.kind && c.ref === o.ref)));
      return;
    }
    const taken = new Set(selected.map((c) => c.key));
    onChange([...selected, { key: keyFor(o, taken), label: o.label, kind: o.kind, ref: o.ref }]);
  };

  if (options.isLoading) {
    return (
      <div className="grid gap-2">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }
  if (options.isError) {
    return <p className="text-status-offline text-sm">{options.error.message}</p>;
  }
  if (!options.data || options.data.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Nothing running yet — deploy a service first, then add it here.
      </p>
    );
  }

  return (
    <div className="border-border max-h-56 overflow-y-auto rounded-xl border">
      {KIND_ORDER.map((kind) => {
        const group = options.data.filter((o) => o.kind === kind);
        if (group.length === 0) return null;
        return (
          <div key={kind}>
            <p className="mono-label text-muted-foreground bg-muted/40 px-3 py-1.5">
              {KIND_TITLE[kind]}
            </p>
            {group.map((option) => {
              const picked = isPicked(option);
              return (
                <button
                  key={`${option.kind}:${option.ref}`}
                  type="button"
                  onClick={() => toggle(option)}
                  className="hover:bg-accent flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm"
                >
                  <span
                    className={cn(
                      'flex size-4 shrink-0 items-center justify-center rounded border',
                      picked ? 'bg-primary border-primary text-primary-foreground' : 'border-border',
                    )}
                  >
                    {picked ? <CheckIcon className="size-3" /> : null}
                  </span>
                  <span className="min-w-0 truncate font-medium">{option.label}</span>
                  {option.hint ? (
                    <span className="text-muted-foreground ml-auto shrink-0 text-xs">
                      {option.hint}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
