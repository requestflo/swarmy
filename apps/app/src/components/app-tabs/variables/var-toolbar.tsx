import * as React from 'react';
import { cn } from '@swarmy/ui';
import { Segmented } from '@/components/service-settings/settings-row';
import type { EnvTab } from './use-env-tabs';

export type VarView = 'table' | 'env' | 'yaml';

const VIEWS: { value: VarView; label: string }[] = [
  { value: 'table', label: 'Table' },
  { value: 'env', label: '.env' },
  { value: 'yaml', label: 'swarmy.yaml' },
];

/** Environment tabs (git apps), the Table / .env / swarmy.yaml switch and Paste .env. */
export function VarToolbar({
  tabs,
  env,
  onEnv,
  view,
  onView,
  paste,
}: {
  tabs: EnvTab[];
  env: string | undefined;
  onEnv: (key: string) => void;
  view: VarView;
  onView: (v: VarView) => void;
  /** Paste .env, at the right. */
  paste?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2 pb-2">
      {tabs.length > 1 ? (
        <Segmented label="Environment" options={tabs.map((t) => ({ value: t.key, label: t.label }))} value={env} onChange={onEnv} />
      ) : null}
      <Segmented label="View" options={VIEWS} value={view} onChange={onView} mono />
      {paste ? <span className="ml-auto">{paste}</span> : null}
    </div>
  );
}

/** "Applies to: All services 14 · web 6 · api 9": which service the table is about. */
export function ScopeChips({
  options,
  value,
  onChange,
  note,
}: {
  options: { id: string | null; label: string; count: number }[];
  value: string | null;
  onChange: (id: string | null) => void;
  note?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-1.5 pb-2">
      <span className="text-muted-foreground mr-1 font-mono text-[11px] tracking-wide uppercase">Applies to</span>
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id ?? 'all'}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.id)}
            className={cn(
              'border-border inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:min-h-11',
              on ? 'bg-surface-2 text-foreground font-semibold ring-1 ring-foreground/25 dark:bg-accent' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {o.label}
            <span className="font-mono text-[10.5px] opacity-80">{o.count}</span>
          </button>
        );
      })}
      {note ? <span className="text-muted-foreground ml-auto font-mono text-[11px]">{note}</span> : null}
    </div>
  );
}
