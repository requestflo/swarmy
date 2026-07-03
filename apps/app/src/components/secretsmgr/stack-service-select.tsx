import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

export interface StackServiceOption {
  id: string;
  name: string;
}

/** Live services belonging to one stack (Docker-truth via the inventory). */
export function useStackServices(stack: string): {
  services: StackServiceOption[];
  isLoading: boolean;
} {
  const trpc = useTRPC();
  const inventory = useQuery(trpc.inventory.get.queryOptions());
  const services = React.useMemo(
    () =>
      (inventory.data?.services ?? [])
        .filter((s) => s.stack === stack)
        .map((s) => ({ id: s.id, name: s.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [inventory.data, stack],
  );
  return { services, isLoading: inventory.isLoading };
}

interface StackServiceSelectProps {
  stack: string;
  value: string;
  onChange: (next: string) => void;
  /** Service names to hide (already attached). */
  exclude?: string[];
  label?: string;
  placeholder?: string;
  /** Copy under the select when nothing is eligible. */
  emptyHint?: string;
}

/** Service picker scoped to the current stack — powers the inline attach flows. */
export function StackServiceSelect({
  stack,
  value,
  onChange,
  exclude,
  label = 'Service',
  placeholder = 'Pick a service in this stack',
  emptyHint = 'No eligible services in this stack.',
}: StackServiceSelectProps): React.JSX.Element {
  const { services, isLoading } = useStackServices(stack);
  const excluded = new Set(exclude ?? []);
  const candidates = services.filter((s) => !excluded.has(s.name));

  return (
    <div className="grid gap-1.5">
      <Label className="mono-label">{label}</Label>
      <Select value={value || undefined} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {candidates.map((s) => (
            <SelectItem key={s.id} value={s.name}>
              {s.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {!isLoading && candidates.length === 0 ? (
        <p className="text-muted-foreground text-xs">{emptyHint}</p>
      ) : null}
    </div>
  );
}
