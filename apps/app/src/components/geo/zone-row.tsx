import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2Icon, TriangleAlertIcon } from 'lucide-react';
import { Badge, Button, Switch, cn, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { type DnsZoneView, zoneModeLabel } from './geo-types';
import { ZoneSettingsRow } from './zone-settings-row';
import { ZoneAutoAddressRow } from './zone-auto-address-row';

interface ZoneRowProps {
  zone: DnsZoneView;
  selected: boolean;
  onSelect: () => void;
}

/** One zone row: mode badge, enabled toggle, delete. Selection expands settings. */
export function ZoneRow({ zone, selected, onSelect }: ZoneRowProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const invalidate = (): void => void qc.invalidateQueries();

  const updateZone = useMutation(
    trpc.geodns.updateZone.mutationOptions({
      onSuccess: invalidate,
      onError: (e) => toast.error(e.message),
    }),
  );
  const removeZone = useMutation(
    trpc.geodns.removeZone.mutationOptions({
      onSuccess: () => {
        toast.success(`Zone ${zone.zone} removed`);
        invalidate();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const conflicts = zone.conflicts ?? [];

  return (
    <div
      className={cn(
        'transition-colors',
        selected ? 'bg-accent/60 border-l-[3px] border-l-primary' : 'hover:bg-accent/40',
      )}
    >
      <div className="flex flex-wrap items-center gap-3 px-6 py-4">
        <button
          type="button"
          onClick={onSelect}
          aria-expanded={selected}
          className="min-h-11 min-w-0 flex-1 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <p className="mono-data truncate font-medium">{zone.zone}</p>
          <p className="text-muted-foreground mono-label truncate">
            serial {zone.serial} · ttl {zone.ttl}s
            {zone.mode === 'swarmy-ns' ? ` · ${zone.nameservers.length} ns pinned` : ''}
          </p>
        </button>
        <Badge variant="muted">{zoneModeLabel(zone.mode)}</Badge>
        {conflicts.length > 0 ? (
          <Badge variant="warning">
            <TriangleAlertIcon className="size-3" /> {conflicts.length} conflict
            {conflicts.length > 1 ? 's' : ''}
          </Badge>
        ) : null}
        <Switch
          checked={zone.enabled}
          onCheckedChange={(v) => updateZone.mutate({ id: zone.id, enabled: v })}
          disabled={updateZone.isPending}
          aria-label={`Zone ${zone.zone} enabled`}
        />
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-tone-bad"
          onClick={(e) => {
            e.stopPropagation();
            removeZone.mutate({ id: zone.id });
          }}
          disabled={removeZone.isPending}
          aria-label={`Remove zone ${zone.zone}`}
        >
          <Trash2Icon className="size-4" />
        </Button>
      </div>

      {selected ? (
        <div className="space-y-3 px-6 pb-4">
          <ZoneSettingsRow zone={zone} />
          <ZoneAutoAddressRow zone={zone} />
          {conflicts.map((c) => (
            <p key={`${c.name}-${c.type}`} className="text-tone-warn text-xs">
              <TriangleAlertIcon className="mr-1 inline size-3.5 align-[-2px]" />
              <span className="mono-data">
                {c.name} {c.type}
              </span>{' '}
              — {c.reason}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
