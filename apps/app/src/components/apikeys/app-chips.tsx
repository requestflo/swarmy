import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@swarmy/ui';
import { FilterChip } from '@/components/blueprints/filter-chip';
import { useTRPC } from '@/integrations/trpc';

/** The org's app (stack) names, for "On these apps" pickers. */
export function useAppNames(): string[] {
  const trpc = useTRPC();
  const stacks = useQuery(trpc.stacks.list.queryOptions());
  return React.useMemo(
    () => [...new Set((stacks.data ?? []).map((s) => s.name))].filter((n) => n !== 'swarmy-system').sort(),
    [stacks.data],
  );
}

/**
 * App chips. `multi`: any set of apps, or "all apps" (null). `single`: one
 * app or all apps. The chosen chips get the quiet coral outline.
 */
export function AppChips({
  value,
  onChange,
  multi,
  label,
  disabled,
}: {
  value: string[] | null;
  onChange: (v: string[] | null) => void;
  multi?: boolean;
  label: string;
  disabled?: boolean;
}): React.JSX.Element {
  const apps = useAppNames();
  const toggle = (name: string): void => {
    if (!multi) return onChange(value?.[0] === name ? null : [name]);
    const set = new Set(value ?? []);
    if (set.has(name)) set.delete(name);
    else set.add(name);
    onChange(set.size ? [...set].sort() : null);
  };
  return (
    <fieldset aria-label={label} disabled={disabled} className={cn('m-0 flex min-w-0 flex-wrap gap-1.5 border-0 p-0', disabled && 'opacity-50')}>
      <FilterChip selected={value === null} onClick={() => onChange(null)}>
        All apps
      </FilterChip>
      {apps.map((name) => (
        <FilterChip key={name} selected={Boolean(value?.includes(name))} onClick={() => toggle(name)}>
          {name}
        </FilterChip>
      ))}
    </fieldset>
  );
}
