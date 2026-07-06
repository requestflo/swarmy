import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { MANUAL_RECORD_TYPES } from './geo-types';

type RecordType = (typeof MANUAL_RECORD_TYPES)[number];

/** Inline add/upsert form for a manual record (no modal). */
export function ManualRecordForm({
  zoneId,
  onDone,
}: {
  zoneId: string;
  onDone: () => void;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [type, setType] = React.useState<RecordType>('TXT');
  const [name, setName] = React.useState('@');
  const [value, setValue] = React.useState('');
  const [ttl, setTtl] = React.useState('');
  const [priority, setPriority] = React.useState('');

  const upsert = useMutation(
    trpc.geodns.upsertRecord.mutationOptions({
      onSuccess: () => {
        toast.success('Record saved');
        setValue('');
        onDone();
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const needsPriority = type === 'MX' || type === 'SRV';
  const canSave = !!name.trim() && !!value.trim() && (!needsPriority || priority !== '');

  const save = (): void => {
    upsert.mutate({
      zoneId,
      name: name.trim(),
      type,
      value: value.trim(),
      ttl: ttl === '' ? undefined : Number(ttl),
      priority: priority === '' ? undefined : Number(priority),
    });
  };

  return (
    <div className="border-border bg-card flex flex-wrap items-center gap-2 rounded-xl border p-3">
      <Select value={type} onValueChange={(v) => setType(v as RecordType)}>
        <SelectTrigger className="h-8 w-24">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {MANUAL_RECORD_TYPES.map((t) => (
            <SelectItem key={t} value={t}>
              {t}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="@ or mail"
        className="h-8 w-28"
        aria-label="Record name"
      />
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={type === 'MX' ? 'mx1.example.com' : type === 'TXT' ? 'v=spf1 …' : 'value'}
        className="h-8 min-w-40 flex-1"
        aria-label="Record value"
      />
      {needsPriority ? (
        <Input
          type="number"
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
          placeholder="prio"
          className="h-8 w-20"
          aria-label="Priority"
        />
      ) : null}
      <Input
        type="number"
        value={ttl}
        onChange={(e) => setTtl(e.target.value)}
        placeholder="ttl"
        className="h-8 w-20"
        aria-label="TTL seconds"
      />
      <Button variant="outline" size="sm" onClick={save} disabled={!canSave || upsert.isPending}>
        Save
      </Button>
    </div>
  );
}
