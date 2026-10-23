import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Input, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { ADDABLE_TYPES, VALUE_HINT, type AddableType } from './zone-records-model';

/** The records table's add row: TXT / MX / CNAME / SRV / CAA through `geodns.upsertRecord`. */
export function RecordAddRow({ zoneId }: { zoneId: string }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [type, setType] = React.useState<AddableType>('TXT');
  const [name, setName] = React.useState('');
  const [value, setValue] = React.useState('');
  const [priority, setPriority] = React.useState('');
  const upsert = useMutation(
    trpc.geodns.upsertRecord.mutationOptions({
      onSuccess: (r) => {
        toast.success(`${r.type} ${r.name} added`);
        setName('');
        setValue('');
        setPriority('');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const needsPriority = type === 'MX' || type === 'SRV';
  const ok = !!value.trim() && (!needsPriority || /^\d+$/.test(priority));
  const add = (): void => {
    if (!ok) return;
    upsert.mutate({
      zoneId,
      type,
      name: name.trim() || '@',
      value: value.trim(),
      ...(needsPriority ? { priority: Number(priority) } : {}),
    });
  };
  const id = React.useId();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        add();
      }}
      aria-label="Add a record"
      className="bg-muted/50 flex flex-wrap items-center gap-2 rounded-md p-2"
    >
      <label htmlFor={`${id}-type`} className="sr-only">Type</label>
      <select
        id={`${id}-type`}
        value={type}
        onChange={(e) => setType(e.target.value as AddableType)}
        className="border-border bg-background h-8 rounded-[8px] border px-2 font-mono text-[12px] pointer-coarse:min-h-11"
      >
        {ADDABLE_TYPES.map((t) => (
          <option key={t} value={t}>{t}</option>
        ))}
      </select>
      <Input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder={type === 'TXT' ? '_dmarc' : '@'} className="h-8 w-32 font-mono text-[12px]" />
      {needsPriority ? (
        <Input aria-label="Priority" inputMode="numeric" value={priority} onChange={(e) => setPriority(e.target.value)} placeholder="10" className="h-8 w-16 font-mono text-[12px]" />
      ) : null}
      <Input aria-label="Value" value={value} onChange={(e) => setValue(e.target.value)} placeholder={VALUE_HINT[type]} className="h-8 min-w-40 flex-1 font-mono text-[12px]" />
      <Button type="submit" variant="outline" size="sm" disabled={!ok || upsert.isPending}>
        {upsert.isPending ? 'Adding…' : 'Add'}
      </Button>
    </form>
  );
}
