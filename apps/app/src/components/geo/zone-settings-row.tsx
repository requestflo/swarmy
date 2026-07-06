import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Input, Label, Switch, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import type { DnsZoneView } from './geo-types';

/** TTL + apex/www derivation toggles for the selected zone. */
export function ZoneSettingsRow({ zone }: { zone: DnsZoneView }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [ttl, setTtl] = React.useState(String(zone.ttl));
  React.useEffect(() => setTtl(String(zone.ttl)), [zone.id, zone.ttl]);

  const updateZone = useMutation(
    trpc.geodns.updateZone.mutationOptions({
      onSuccess: () => void qc.invalidateQueries(),
      onError: (e) => toast.error(e.message),
    }),
  );

  const saveTtl = (): void => {
    const n = Number(ttl);
    if (Number.isFinite(n) && n !== zone.ttl) updateZone.mutate({ id: zone.id, ttl: n });
  };

  return (
    <div className="bg-accent/40 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl px-4 py-3">
      <div className="flex items-center gap-2">
        <Label htmlFor={`ttl-${zone.id}`} className="mono-label">
          TTL
        </Label>
        <Input
          id={`ttl-${zone.id}`}
          type="number"
          min={10}
          max={120}
          value={ttl}
          onChange={(e) => setTtl(e.target.value)}
          onBlur={saveTtl}
          onKeyDown={(e) => e.key === 'Enter' && saveTtl()}
          className="h-8 w-20"
        />
        <span className="text-muted-foreground text-xs">10–120s · low biases failover</span>
      </div>
      <div className="flex items-center gap-2">
        <Switch
          id={`apex-${zone.id}`}
          checked={zone.apexToEdge}
          onCheckedChange={(v) => updateZone.mutate({ id: zone.id, apexToEdge: v })}
          disabled={updateZone.isPending}
        />
        <Label htmlFor={`apex-${zone.id}`} className="text-sm">
          Apex → edge
        </Label>
      </div>
      <div className="flex items-center gap-2">
        <Switch
          id={`www-${zone.id}`}
          checked={zone.autoWww}
          onCheckedChange={(v) => updateZone.mutate({ id: zone.id, autoWww: v })}
          disabled={updateZone.isPending}
        />
        <Label htmlFor={`www-${zone.id}`} className="text-sm">
          Auto www
        </Label>
      </div>
    </div>
  );
}
