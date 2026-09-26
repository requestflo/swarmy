import * as React from 'react';
import { Button, cn } from '@swarmy/ui';
import type { SettingsDraftState } from './use-settings-draft';

/**
 * "1 change · rolling, 1 copy at a time · ~50 s", the tech diff, Reset and
 * the ONE coral Apply. Renders only while the draft has changes.
 */
export function SettingsApplyBar({ d, className }: { d: SettingsDraftState; className?: string }): React.JSX.Element | null {
  if (d.changes.length === 0) return null;
  const rolling = d.changes.some((c) => c.key !== 'replicas');
  return (
    <div
      role="region"
      aria-label="Unsaved changes"
      className={cn('bg-card border-border flex flex-wrap items-center gap-x-4 gap-y-2 border-t px-4 py-3', className)}
    >
      <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
        <p aria-live="polite" className="text-[13.5px] font-semibold">
          {d.sentence}
        </p>
        <p className="text-muted-foreground font-mono text-[11.5px] break-words">
          {d.changes.map((c) => `${c.key} ${c.from} → ${c.to}`).join(' · ')}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" className="pointer-coarse:min-h-11" disabled={d.applying} onClick={d.reset}>
          Reset
        </Button>
        <Button size="sm" className="pointer-coarse:min-h-11" disabled={d.applying} onClick={d.apply}>
          {d.applying ? 'Applying…' : rolling ? 'Apply (rolling, 1 at a time)' : 'Apply'}
        </Button>
      </div>
    </div>
  );
}
