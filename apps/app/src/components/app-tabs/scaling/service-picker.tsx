import * as React from 'react';
import { Segmented } from '@/components/service-settings/settings-row';
import { shortName } from '../use-stack-services';
import type { PlacedService } from './use-app-placement';

/** "web ×3 · api ×4 · checkout ×2": which service the rest of the page is about. */
export function ServicePicker({
  stack,
  rows,
  value,
  onChange,
}: {
  stack: string;
  rows: PlacedService[];
  value: string | undefined;
  onChange: (id: string) => void;
}): React.JSX.Element | null {
  if (rows.length < 2) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="text-muted-foreground text-[12.5px]">Service</span>
      <Segmented
        label="Service"
        options={rows.map((r) => ({ value: r.inv.id, label: `${shortName(stack, r.inv.name)} ×${r.inv.replicas.desired}` }))}
        value={value}
        onChange={onChange}
      />
    </div>
  );
}
