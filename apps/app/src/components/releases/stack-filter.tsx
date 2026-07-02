import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

const ALL = '__all__';

/** Scope the feed to one stack (drives the per-stack history + safety card). */
export function StackFilter({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (stackName: string | null) => void;
}): React.JSX.Element {
  const trpc = useTRPC();
  const stacks = useQuery(trpc.stacks.list.queryOptions());

  return (
    <Select value={value ?? ALL} onValueChange={(v) => onChange(v === ALL ? null : v)}>
      <SelectTrigger className="w-48">
        <SelectValue placeholder="All stacks" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All stacks</SelectItem>
        {(stacks.data ?? []).map((s) => (
          <SelectItem key={s.id} value={s.name}>
            {s.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
