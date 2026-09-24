import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowRightIcon, TableIcon } from 'lucide-react';
import { Card, CardContent } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { ENGINE_BADGE } from './studio-types';

/** Data tab entry: every database of the app with a link into its studio. Hidden when there are none. */
export function StudioEntryCard({ stack }: { stack: string }): React.JSX.Element | null {
  const trpc = useTRPC();
  const q = useQuery(trpc.studio.targets.queryOptions({ stack }));
  if (!q.data || q.data.length === 0) return null;
  return (
    <Card className="card-pop border-0">
      <CardContent className="space-y-4 p-6">
        <div className="flex items-center gap-3">
          <span className="bg-primary/10 text-primary flex size-9 items-center justify-center rounded-lg">
            <TableIcon className="size-5" />
          </span>
          <div>
            <h3 className="leading-tight font-semibold">Database studio</h3>
            <p className="text-muted-foreground mono-label">Browse, edit and query · read-only by default · every query audited</p>
          </div>
        </div>
        <div className="divide-border divide-y">
          {q.data.map((t) => (
            <Link key={t.name} to="/stacks/$name/studio" params={{ name: stack }} search={{ db: t.name }} className="hover:bg-accent/60 -mx-2 flex items-center gap-3 rounded-lg px-2 py-2.5">
              <span className="bg-muted text-status-progress inline-flex size-7 items-center justify-center rounded-lg font-mono text-[10px] font-bold">{ENGINE_BADGE[t.engine]}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{t.name}</span>
                <span className="text-muted-foreground block truncate font-mono text-[11px]">
                  {t.engine}{t.kind === 'managed' ? ' · managed' : ''}{t.unavailable ? ` · ${t.unavailable}` : !t.running ? ' · not running' : ''}
                </span>
              </span>
              <span className="text-primary inline-flex items-center gap-1 text-xs font-semibold">Open studio <ArrowRightIcon className="size-3.5" /></span>
            </Link>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
