import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ShieldIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { studioActivity } from './studio-activity';
import type { StudioScope } from './studio-types';

/**
 * Who else has been querying this database — the team's last few studio runs,
 * read from the audit log (`studio.query` on this database). Quiet: nothing
 * shows until there's something to say.
 */
export function StudioTeamActivity({ scope }: { scope: StudioScope }): React.JSX.Element | null {
  const trpc = useTRPC();
  const q = useQuery({
    ...trpc.audit.list.queryOptions({
      action: 'studio.query',
      resourceType: 'database',
      resourceId: `${scope.stack}/${scope.target.name}`,
      limit: 200,
    }),
    refetchInterval: 30_000,
  });
  const lines = studioActivity(q.data?.entries ?? []);
  if (lines.length === 0) return null;
  return (
    <div className="border-border mt-auto flex flex-col gap-1 border-t pt-3" aria-label="Team activity">
      <span className="mono-label text-muted-foreground">Team activity · anyone, from the audit log</span>
      {lines.map((l) => (
        <div key={l.id} className="text-muted-foreground flex min-w-0 items-center gap-2 font-mono text-[11.5px]">
          <ShieldIcon className="size-3 shrink-0" aria-hidden />
          <span className="shrink-0">
            <span className="text-foreground">{l.who}</span> {l.what}
          </span>
          {l.statement ? (
            <span className="hidden min-w-0 truncate opacity-80 md:inline" title={l.statement}>
              · {l.statement}
            </span>
          ) : null}
          <span className={cn('shrink-0', l.failed && 'text-tone-bad')}>{l.detail ? `· ${l.detail}` : ''}</span>
          <span className="shrink-0">· {l.at}</span>
        </div>
      ))}
    </div>
  );
}
