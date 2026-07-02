import * as React from 'react';
import { Input, Label } from '@swarmy/ui';

/**
 * Parse a `region=replicas, region=replicas` plan string into the provision
 * input's regions array. Invalid fragments are dropped (forgiving input).
 */
export function parseRegionPlans(raw: string): { region: string; replicas: number }[] {
  const out: { region: string; replicas: number }[] = [];
  for (const part of raw.split(',')) {
    const m = /^\s*([A-Za-z0-9][A-Za-z0-9_.-]*)\s*=\s*(\d{1,2})\s*$/.exec(part);
    if (!m || !m[1]) continue;
    const replicas = Number(m[2]);
    if (replicas > 0) out.push({ region: m[1], replicas });
  }
  return out;
}

/** Optional per-region read-replica plan (`swarmy.cache.region.<r>.replicas`). */
export function CacheRegionField({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}): React.JSX.Element {
  return (
    <div className="grid gap-1.5">
      <Label className="mono-label">Region replicas (optional)</Label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="eu-west=2, us-east=1"
      />
      <p className="text-muted-foreground text-[11px]">
        Pins read replicas to nodes labelled with those regions (swarmy.region).
      </p>
    </div>
  );
}
