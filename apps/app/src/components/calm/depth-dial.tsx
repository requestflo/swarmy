import * as React from 'react';
import { CodeIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import { DEPTHS, DEPTH_LABEL, useDepthDefault, usePageDepth, type DepthName } from './depth';

interface SegProps {
  value: DepthName;
  onChange: (d: DepthName) => void;
  label: string;
  tone?: 'page' | 'nav';
  size?: 'sm' | 'md';
}

/** The three-way segmented control, shared by the nav dial, page and section switches. */
export function DepthSegments({ value, onChange, label, tone = 'page', size = 'md' }: SegProps): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        'inline-flex gap-0.5 rounded-[10px] border p-0.5',
        tone === 'nav' ? 'flex w-full border-[var(--nav-line)] bg-black/15' : 'border-border bg-background',
      )}
    >
      {DEPTHS.map((d) => {
        const on = d === value;
        return (
          <button
            key={d}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(d)}
            className={cn(
              'inline-flex items-center justify-center gap-1 rounded-[8px] font-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:min-h-11',
              size === 'sm' ? 'h-6 px-2 text-[11px]' : 'h-7 px-2.5 text-xs',
              tone === 'nav' && 'flex-1 px-1',
              on
                ? tone === 'nav'
                  ? 'bg-[var(--nav-active)] text-nav-foreground'
                  : 'bg-surface-2 text-foreground shadow-xs dark:bg-accent'
                : tone === 'nav'
                  ? 'text-nav-muted hover:text-nav-foreground'
                  : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {d === 'code' && tone === 'page' ? <CodeIcon aria-hidden className="size-3.5" /> : null}
            {DEPTH_LABEL[d]}
          </button>
        );
      })}
    </div>
  );
}

/** The sidenav "Show me" dial: sets the person's default depth. */
export function DepthDial(): React.JSX.Element {
  const { value, set } = useDepthDefault();
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-[var(--nav-line)] bg-white/[0.03] p-2.5">
      <span className="text-nav-muted text-[11.5px] font-semibold">Show me</span>
      <DepthSegments value={value} onChange={set} label="How much detail to show by default" tone="nav" size="sm" />
      <span className="text-nav-muted text-[11px] leading-snug">Your default. Every page can still switch.</span>
    </div>
  );
}

/** The top-bar switch: this page only; navigating away returns to the default. */
export function PageDepthSwitch(): React.JSX.Element {
  const { depth, setDepth } = usePageDepth();
  return <DepthSegments value={depth} onChange={setDepth} label="Detail on this page" />;
}
