import * as React from 'react';
import { SearchIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import type { StatusFilter } from './app-board-model';

export type Grouping = 'none' | 'env';

const FILTERS: [StatusFilter, string][] = [
  ['all', 'All'],
  ['attn', 'Needs you'],
  ['ok', 'Online'],
  ['idle', 'Asleep'],
];

function Seg({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-[8px] px-2.5 text-[12.5px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:min-h-11',
        pressed ? 'bg-surface-2 text-foreground dark:bg-accent' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

/** Typing "/" anywhere outside a field jumps to the search box. */
function useSlashFocus(ref: React.RefObject<HTMLInputElement | null>): void {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      e.preventDefault();
      ref.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ref]);
}

/** Search (/ to focus), status chips with counts, and Group: None | Environment. */
export function AppsControls({
  q,
  onQ,
  status,
  onStatus,
  counts,
  group,
  onGroup,
}: {
  q: string;
  onQ: (q: string) => void;
  status: StatusFilter;
  onStatus: (s: StatusFilter) => void;
  counts: Record<StatusFilter, number>;
  group: Grouping;
  onGroup: (g: Grouping) => void;
}): React.JSX.Element {
  const input = React.useRef<HTMLInputElement>(null);
  useSlashFocus(input);
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <label className="border-input bg-card text-muted-foreground focus-within:border-primary focus-within:ring-primary/20 flex h-9 w-full items-center gap-2 rounded-[10px] border pr-2.5 pl-3 focus-within:ring-[3px] sm:w-[300px] pointer-coarse:h-11">
        <SearchIcon aria-hidden className="size-3.5 shrink-0" />
        <input
          ref={input}
          type="search"
          value={q}
          onChange={(e) => onQ(e.target.value)}
          aria-label="Search apps"
          placeholder="Search apps, addresses, servers"
          className="text-foreground placeholder:text-muted-foreground h-full min-w-0 flex-1 bg-transparent text-[13.5px] outline-none"
        />
        <kbd className="bg-surface-2 text-muted-foreground border-border rounded-md border px-1.5 font-mono text-[11px] leading-4 dark:bg-accent">/</kbd>
      </label>
      <div role="group" aria-label="Filter by status" className="border-border bg-card inline-flex flex-wrap gap-0.5 rounded-[11px] border p-[3px]">
        {FILTERS.map(([k, label]) => (
          <Seg key={k} pressed={status === k} onClick={() => onStatus(k)}>
            {label}
            <span className="text-muted-foreground font-mono text-[10.5px]">{counts[k]}</span>
          </Seg>
        ))}
      </div>
      <div className="flex items-center gap-2.5 sm:ml-auto">
        <span className="calm-eyebrow">Group</span>
        <div role="group" aria-label="Group apps" className="border-border bg-card inline-flex gap-0.5 rounded-[11px] border p-[3px]">
          <Seg pressed={group === 'none'} onClick={() => onGroup('none')}>None</Seg>
          <Seg pressed={group === 'env'} onClick={() => onGroup('env')}>Environment</Seg>
        </div>
      </div>
    </div>
  );
}
