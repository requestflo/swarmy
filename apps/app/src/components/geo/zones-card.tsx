import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { GlobeIcon, PlusIcon } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { type DnsZoneView, type ZoneMode, ZONE_MODES } from './geo-types';
import { ZoneRow } from './zone-row';

interface ZonesCardProps {
  zones: DnsZoneView[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/** The zone roster — one row per registrar-facing zone, selectable. */
export function ZonesCard({ zones, selectedId, onSelect }: ZonesCardProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [zone, setZone] = React.useState('');
  const [mode, setMode] = React.useState<ZoneMode>('swarmy-ns');

  const createZone = useMutation(
    trpc.geodns.createZone.mutationOptions({
      onSuccess: (z) => {
        toast.success(`Zone ${z.zone} added`);
        setZone('');
        onSelect(z.id);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const add = (): void => {
    if (zone.trim()) createZone.mutate({ zone: zone.trim(), mode });
  };

  return (
    <Card className="card-pop border-0">
      <CardHeader className="flex-row items-center justify-between gap-4 space-y-0">
        <CardTitle className="text-base">Zones</CardTitle>
        <div className="flex items-center gap-2">
          <Input
            value={zone}
            onChange={(e) => setZone(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            placeholder="example.com"
            className="h-8 w-44 sm:w-56"
          />
          <Select value={mode} onValueChange={(v) => setMode(v as ZoneMode)}>
            <SelectTrigger className="h-8 w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ZONE_MODES.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={add} disabled={!zone.trim() || createZone.isPending}>
            <PlusIcon className="size-4" /> Add zone
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {zones.length === 0 ? (
          <div className="px-6 pb-8">
            <EmptyState
              icon={<GlobeIcon />}
              title="No zones yet"
              description="Add your domain and swarmy becomes its nameserver — every routed host resolves geo-steered, automatically."
            />
          </div>
        ) : (
          <div className="divide-border divide-y border-t">
            {zones.map((z) => (
              <ZoneRow
                key={z.id}
                zone={z}
                selected={z.id === selectedId}
                onSelect={() => onSelect(z.id)}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
