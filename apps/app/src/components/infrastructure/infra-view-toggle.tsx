import * as React from 'react';
import { GlobeIcon, LayoutGridIcon, Loader2Icon } from 'lucide-react';
import { cn } from '@swarmy/ui';

export type InfraView = 'canvas' | 'globe';

/** Segmented Canvas | Globe switch for the secondary map section below the node list. */
export function InfraViewToggle({
  view,
  onChange,
}: {
  view: InfraView;
  onChange: (v: InfraView) => void;
}): React.JSX.Element {
  return (
    <div className="bg-muted/60 inline-flex items-center gap-1 rounded-full p-1">
      <ToggleButton
        active={view === 'canvas'}
        onClick={() => onChange('canvas')}
        icon={<LayoutGridIcon className="size-3.5" />}
        label="Canvas"
      />
      <ToggleButton
        active={view === 'globe'}
        onClick={() => onChange('globe')}
        icon={<GlobeIcon className="size-3.5" />}
        label="Globe"
      />
    </div>
  );
}

function ToggleButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold transition-colors',
        active
          ? 'bg-card text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

export function InfraGlobeFallback(): React.JSX.Element {
  return (
    <div className="border-border/60 bg-card/30 text-muted-foreground flex h-[clamp(520px,68vh,860px)] w-full items-center justify-center rounded-3xl border">
      <Loader2Icon className="size-5 animate-spin" />
    </div>
  );
}
