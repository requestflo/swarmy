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

/** Labelled field wrapper shared by the data-service provision forms. */
export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="grid gap-1.5">
      <Label className="mono-label">{label}</Label>
      {children}
    </div>
  );
}

/** "Attach to service (optional)" picker shared by the provision forms. */
export function AttachServiceField({
  value,
  onChange,
}: {
  value: string;
  onChange: (service: string) => void;
}): React.JSX.Element {
  const trpc = useTRPC();
  const services = useQuery(trpc.services.list.queryOptions({}));
  return (
    <Field label="Attach to service (optional)">
      <Select value={value || 'none'} onValueChange={(v) => onChange(v === 'none' ? '' : v)}>
        <SelectTrigger><SelectValue placeholder="No app yet" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="none">No app yet</SelectItem>
          {(services.data ?? []).map((s) => (
            <SelectItem key={s.id} value={s.name}>{s.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}
