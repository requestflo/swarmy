import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { StethoscopeIcon } from 'lucide-react';
import { Button, Popover, PopoverContent, PopoverTrigger, StatusBadge } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/** On-demand `checkDomain` probe: intended answers vs public DNS + reachability. */
export function DomainCheckPopover({ host }: { host: string }): React.JSX.Element {
  const trpc = useTRPC();
  const [open, setOpen] = React.useState(false);
  const check = useQuery({
    ...trpc.geodns.checkDomain.queryOptions({ host }),
    enabled: open,
    refetchOnWindowFocus: false,
  });
  const c = check.data;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="text-muted-foreground" aria-label={`Check ${host}`}>
          <StethoscopeIcon className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3">
        <p className="mono-data text-sm font-medium">{host}</p>
        {check.isFetching ? (
          <p className="text-muted-foreground text-sm">Probing public DNS…</p>
        ) : check.isError ? (
          <p className="text-status-offline text-sm">{check.error.message}</p>
        ) : c ? (
          <>
            <div className="flex flex-wrap gap-2">
              <StatusBadge tone={c.resolves ? 'online' : 'offline'} label={c.resolves ? 'resolves' : 'no answer'} />
              <StatusBadge
                tone={c.served ? 'online' : c.resolves ? 'warning' : 'neutral'}
                label={c.served ? 'served by swarmy' : 'not swarmy'}
              />
              <StatusBadge tone={c.reachable ? 'online' : 'warning'} label={c.reachable ? 'reachable' : 'unreachable'} />
            </div>
            <div className="space-y-1 text-xs">
              <p className="text-muted-foreground">
                Public answer: <span className="mono-data">{c.gotIp || '—'}</span>
              </p>
              <p className="text-muted-foreground">
                swarmy serves:{' '}
                <span className="mono-data">{c.expectedIps.length > 0 ? c.expectedIps.join(', ') : '—'}</span>
              </p>
            </div>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
