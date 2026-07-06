import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { RadarIcon } from 'lucide-react';
import { Button, StatusBadge, cn } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

interface DelegationCheckProps {
  zoneId: string;
  hasNameservers: boolean;
}

/** Live delegation probe: public NS lookup + a direct SOA query per glue IP. */
export function DelegationCheck({ zoneId, hasNameservers }: DelegationCheckProps): React.JSX.Element {
  const trpc = useTRPC();
  const [armed, setArmed] = React.useState(false);
  React.useEffect(() => setArmed(false), [zoneId]);

  const check = useQuery({
    ...trpc.geodns.checkDelegation.queryOptions({ id: zoneId }),
    enabled: armed,
    refetchOnWindowFocus: false,
  });

  const d = check.data;

  return (
    <div>
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          disabled={!hasNameservers || check.isFetching}
          onClick={() => (armed ? void check.refetch() : setArmed(true))}
        >
          <RadarIcon className={cn('size-4', check.isFetching && 'animate-pulse')} />
          {check.isFetching ? 'Checking…' : 'Check delegation'}
        </Button>
        {d ? (
          <StatusBadge
            tone={d.delegated ? 'online' : 'warning'}
            label={d.delegated ? 'Delegated to swarmy' : 'Not delegated yet'}
          />
        ) : null}
      </div>

      {check.isError ? (
        <p className="text-status-offline mt-2 text-xs">{check.error.message}</p>
      ) : null}

      {d ? (
        <div className="mt-3 space-y-1.5">
          {d.nameservers.map((ns) => (
            <div key={ns.fqdn} className="flex flex-wrap items-center gap-2 text-xs">
              <span className="mono-data min-w-0 flex-1 truncate">{ns.fqdn}</span>
              <StatusBadge
                tone={ns.reachable ? 'online' : 'offline'}
                label={ns.reachable ? 'answering' : 'unreachable'}
              />
              <StatusBadge
                tone={ns.serialMatches ? 'online' : ns.reachable ? 'warning' : 'neutral'}
                label={
                  ns.serialMatches ? 'serial in sync' : ns.serial != null ? `serial ${ns.serial}` : 'no serial'
                }
              />
            </div>
          ))}
          {d.publicNs.length > 0 && !d.delegated ? (
            <p className="text-muted-foreground text-xs">
              Public DNS currently returns: <span className="mono-data">{d.publicNs.join(', ')}</span>
            </p>
          ) : null}
          {d.publicNs.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              Public DNS returns no NS records yet — registrar changes can take hours.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
