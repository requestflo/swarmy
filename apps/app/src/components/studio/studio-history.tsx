import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { HistoryIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CLASS_TONE } from './studio-verdict';
import type { StudioScope } from './studio-types';

/** My recent runs on this database — read back from the audit log. Click to reuse. */
export function StudioHistory({ scope, onPick, refreshKey }: { scope: StudioScope; onPick: (s: string) => void; refreshKey: unknown }): React.JSX.Element | null {
  const trpc = useTRPC();
  const q = useQuery(trpc.studio.history.queryOptions({ stack: scope.stack, target: scope.target.name, limit: 25 }));
  const { refetch } = q;
  React.useEffect(() => {
    if (refreshKey) void refetch();
  }, [refreshKey, refetch]);
  const rows = q.data ?? [];
  if (rows.length === 0) return null;
  return (
    <div className="calm-card shadow-none overflow-hidden border-0">
      <div className="border-border flex items-center gap-2 border-b px-3 py-2">
        <HistoryIcon className="text-muted-foreground size-3.5" />
        <span className="mono-label text-muted-foreground">History · yours, from the audit log</span>
      </div>
      <ul className="max-h-64 overflow-auto">
        {rows.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => onPick(r.statement)}
              className="hover:bg-accent/60 border-border flex w-full items-center gap-3 border-b px-3 py-2 text-left"
            >
              <span className={cn('shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[10px]', CLASS_TONE[r.class])}>{r.class}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{r.statement}</span>
              <span className={cn('shrink-0 font-mono text-[11px]', r.status === 'ok' ? 'text-muted-foreground' : 'text-status-offline')}>
                {r.status === 'ok' ? `${r.rows ?? 0} rows · ${r.durationMs ?? 0} ms` : 'failed'}
              </span>
              <span className="text-muted-foreground hidden shrink-0 font-mono text-[11px] sm:inline">{new Date(r.at).toLocaleTimeString()}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
