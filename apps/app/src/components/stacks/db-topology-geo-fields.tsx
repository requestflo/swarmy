import * as React from 'react';
import { MapPinIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { Button, Input, Label } from '@swarmy/ui';
import type { DbGeoRegionPlan as DbGeoRegion } from '@swarmy/core';

interface GeoFieldsProps {
  writeRegion: string;
  onWriteRegion: (value: string) => void;
  regions: DbGeoRegion[];
  onRegions: (next: DbGeoRegion[]) => void;
}

/**
 * Geo-topology editor: the single write region plus a per-region read-replica
 * plan. Used by `DbTopologySelector` only when the chosen topology is `geo`.
 */
export function DbTopologyGeoFields({
  writeRegion,
  onWriteRegion,
  regions,
  onRegions,
}: GeoFieldsProps): React.JSX.Element {
  const setRegion = (i: number, patch: Partial<DbGeoRegion>): void =>
    onRegions(regions.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const remove = (i: number): void => onRegions(regions.filter((_, idx) => idx !== i));
  const add = (): void => onRegions([...regions, { region: '', replicas: 1 }]);

  return (
    <div className="border-border bg-muted/30 space-y-4 rounded-lg border p-4">
      <div className="grid max-w-xs gap-1.5">
        <Label htmlFor="db-write-region" className="mono-label">
          Write region
        </Label>
        <Input
          id="db-write-region"
          value={writeRegion}
          onChange={(e) => onWriteRegion(e.target.value)}
          placeholder="eu-west"
        />
        <p className="text-muted-foreground mono-label">Holds the single writer; others are read-only.</p>
      </div>

      <div className="space-y-2">
        <p className="mono-label text-muted-foreground">Replicas per region</p>
        {regions.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <MapPinIcon className="text-muted-foreground size-4 shrink-0" />
            <Input
              aria-label={`Region ${i + 1}`}
              value={r.region}
              onChange={(e) => setRegion(i, { region: e.target.value })}
              placeholder="us-east"
              className="w-40"
            />
            <Input
              aria-label={`Replicas in region ${i + 1}`}
              type="number"
              min={0}
              max={20}
              value={r.replicas}
              onChange={(e) => setRegion(i, { replicas: Math.max(0, Number(e.target.value)) })}
              className="w-24"
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove region ${i + 1}`}
              disabled={regions.length <= 1}
              onClick={() => remove(i)}
            >
              <Trash2Icon className="size-4" />
            </Button>
          </div>
        ))}
        <Button variant="outline" size="sm" className="rounded-full" onClick={add}>
          <PlusIcon className="size-4" /> Add region
        </Button>
      </div>
    </div>
  );
}
