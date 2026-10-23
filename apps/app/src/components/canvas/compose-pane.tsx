import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { cn } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import type { AppItem } from '@/components/apps/use-apps';
import { useAppDrift } from '@/components/app-tabs/scaling/use-app-drift';
import { liveCompose } from '@/components/stacks/workspace/app-code';
import { relTime } from '@/lib/format';

/** "in sync" / "3 changes not in git" — only for an app swarmy.yaml manages and has checked. */
function DriftChip({ stack }: { stack: string }): React.JSX.Element | null {
  const d = useAppDrift(stack);
  if (!d.git || d.changes === null) return null;
  const synced = d.changes === 0;
  return (
    <span className="flex flex-col items-end gap-0.5">
      <span
        className={cn(
          'rounded-full border px-2 py-0.5 font-mono text-[10.5px] font-semibold',
          synced ? 'border-status-online/40 text-tone-ok' : 'border-status-warning/40 text-tone-warn',
        )}
      >
        {synced ? 'in sync' : `${d.changes} change${d.changes === 1 ? '' : 's'} not in git`}
      </span>
      <Tech>apps.drift · checked {d.checkedAt ? relTime(d.checkedAt) : 'never'}</Tech>
    </span>
  );
}

/**
 * The app's live spec beside the canvas (board AppCanvas "Compose"): the
 * compose swarmy rebuilds from what Docker runs right now, read-only, with
 * whether it still matches git when the app is git-managed.
 */
export function ComposePane({ app, className }: { app: AppItem; className?: string }): React.JSX.Element {
  return (
    <aside aria-label="Live spec" className={cn('flex min-h-0 flex-col gap-2 p-3', className)}>
      <div className="flex items-start gap-2">
        <span className="text-muted-foreground flex-1 pt-0.5 font-mono text-[11px] tracking-[0.08em] uppercase">compose · live spec</span>
        <DriftChip stack={app.name} />
      </div>
      <pre className="calm-code min-h-0 flex-1 overflow-auto px-3 py-2.5 text-[11.5px] leading-relaxed">{liveCompose(app)}</pre>
      <Link
        to="/stacks/$name/source"
        params={{ name: app.name }}
        className="text-primary self-start font-mono text-[11px] hover:underline pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
      >
        where it comes from →
      </Link>
    </aside>
  );
}
