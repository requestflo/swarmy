import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Label, Switch, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import type { DnsZoneView } from './geo-types';

/**
 * "Give every app an address in this zone" — `<service>-<stack>.<zone>`,
 * answered by swarmy's own nameservers, instead of the sslip.io fallback.
 * The server refuses until the zone is live-delegated, and says why.
 */
export function ZoneAutoAddressRow({ zone }: { zone: DnsZoneView }): React.JSX.Element | null {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const set = useMutation(
    trpc.geodns.setZoneAutoAddresses.mutationOptions({
      onSuccess: (z) => {
        toast.success(z.autoAddresses ? `Apps now get addresses under ${z.zone}` : 'Apps are back on sslip.io addresses');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  if (zone.mode !== 'swarmy-ns') return null;
  const id = `auto-addr-${zone.id}`;
  return (
    <div className="bg-accent/40 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl px-4 py-3">
      <Switch
        id={id}
        checked={zone.autoAddresses}
        disabled={set.isPending || !zone.enabled}
        onCheckedChange={(v) => set.mutate({ id: zone.id, enabled: v })}
      />
      <Label htmlFor={id} className="text-sm">
        App addresses in this zone
      </Label>
      <span className="text-muted-foreground min-w-0 flex-1 text-xs">
        Every public app gets <span className="mono-data break-all">&lt;app&gt;.{zone.zone}</span>, answered by your own
        nameservers — no sslip.io. Needs the NS delegation above to be live; existing addresses move over.
      </span>
    </div>
  );
}
