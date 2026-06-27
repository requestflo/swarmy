import * as React from 'react';

/** Target-OS row. Linux is live; the rest are clearly flagged as coming soon. */
export function OsPicker(): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="mono-label text-muted-foreground mr-1">Target OS</span>
      <span className="bg-ink text-ink-foreground inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-bold">
        <span className="pulse-dot bg-status-online" /> Linux
      </span>
      <span className="text-muted-foreground inline-flex items-center gap-2 rounded-full border border-dashed px-3 py-1 text-xs font-medium">
        macOS / Windows · soon
      </span>
    </div>
  );
}
