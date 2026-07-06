import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { NodeSummary } from '@swarmy/core';
import { Button, cn, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import type { DnsZoneView } from './geo-types';

interface NsNodePickerProps {
  zone: DnsZoneView;
  /** Nodes eligible as nameservers: ingress+outlet with a region and public IP. */
  eligible: NodeSummary[];
}

/** Pick 2–4 pinned NS nodes — click order becomes ns1..nsN. */
export function NsNodePicker({ zone, eligible }: NsNodePickerProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [picked, setPicked] = React.useState<string[]>(zone.advertisedNodeIds);
  React.useEffect(() => setPicked(zone.advertisedNodeIds), [zone.id, zone.advertisedNodeIds]);

  const setAdvertisedNs = useMutation(
    trpc.geodns.setAdvertisedNs.mutationOptions({
      onSuccess: () => {
        toast.success('Nameserver set pinned');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const toggle = (id: string): void => {
    setPicked((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : prev.length >= 4 ? prev : [...prev, id],
    );
  };

  const dirty =
    picked.length !== zone.advertisedNodeIds.length ||
    picked.some((id, i) => zone.advertisedNodeIds[i] !== id);

  return (
    <div>
      <p className="mono-label text-muted-foreground mb-2">Nameserver nodes · pick 2–4</p>
      {eligible.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No eligible nodes yet. A nameserver node needs the ingress and outlet roles, a region,
          and a public IP — set them below in node regions.
        </p>
      ) : (
        <div className="border-border divide-border divide-y rounded-xl border">
          {eligible.map((n) => {
            const idx = picked.indexOf(n.id);
            return (
              <button
                key={n.id}
                type="button"
                onClick={() => toggle(n.id)}
                className={cn(
                  'flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors',
                  idx >= 0 ? 'bg-accent/60' : 'hover:bg-accent/40',
                )}
              >
                <span
                  className={cn(
                    'mono-data flex h-6 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold',
                    idx >= 0 ? 'bg-primary text-primary-foreground' : 'bg-accent text-muted-foreground',
                  )}
                >
                  {idx >= 0 ? `ns${idx + 1}` : '·'}
                </span>
                <span className="min-w-0 flex-1 truncate font-medium">{n.name}</span>
                <span className="mono-label text-muted-foreground shrink-0">{n.region}</span>
                <span className="mono-data text-muted-foreground hidden shrink-0 sm:inline">
                  {n.publicIp}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {eligible.length > 0 ? (
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="text-muted-foreground text-xs">
            {picked.length < 2 ? 'Registrars require at least 2.' : `${picked.length} pinned in order.`}
          </p>
          <Button
            size="sm"
            onClick={() => setAdvertisedNs.mutate({ id: zone.id, nodeIds: picked })}
            disabled={!dirty || picked.length < 2 || picked.length > 4 || setAdvertisedNs.isPending}
          >
            Pin nameservers
          </Button>
        </div>
      ) : null}
    </div>
  );
}
