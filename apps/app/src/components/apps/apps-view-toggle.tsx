import * as React from 'react';
import { ListIcon, MapIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';

export type AppsView = 'list' | 'map';
const KEY = 'swarmy-apps-view';

/** The List | Map choice, remembered per browser (a view, never navigation). */
export function useAppsView(): [AppsView, (v: AppsView) => void] {
  const [view, setView] = React.useState<AppsView>(() => {
    try {
      return window.localStorage.getItem(KEY) === 'map' ? 'map' : 'list';
    } catch {
      return 'list';
    }
  });
  const set = React.useCallback((v: AppsView) => {
    setView(v);
    try {
      window.localStorage.setItem(KEY, v);
    } catch {
      // storage unavailable: the choice lasts for this visit
    }
  }, []);
  return [view, set];
}

const LABEL: Record<AppsView, string> = { list: 'List', map: 'Map' };
const ICON = { list: ListIcon, map: MapIcon } as const;

export function AppsViewToggle({ view, onChange }: { view: AppsView; onChange: (v: AppsView) => void }): React.JSX.Element {
  return (
    <div role="group" aria-label="View" className="border-border inline-flex rounded-[10px] border p-0.5">
      {(['list', 'map'] as const).map((v) => (
        <button
          key={v}
          type="button"
          aria-pressed={view === v}
          onClick={() => onChange(v)}
          className={cn(
            'inline-flex h-7 items-center gap-1.5 rounded-[8px] px-3 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:min-h-11',
            view === v ? 'bg-surface-2 text-foreground dark:bg-accent' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {React.createElement(ICON[v], { 'aria-hidden': true, className: 'size-3.5' })}
          {LABEL[v]}
        </button>
      ))}
    </div>
  );
}
