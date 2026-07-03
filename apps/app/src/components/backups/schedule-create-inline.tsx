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
import { Field } from './field';
import type { TargetOption } from './target-option';

type Unit = 'minutes' | 'hours' | 'days';

interface ScheduleCreateInlineProps {
  stack: string;
  targets: TargetOption[];
  onDone: () => void;
}

/** Inline schedule form — expands inside the schedules card, never a modal. */
export function ScheduleCreateInline({
  stack,
  targets,
  onDone,
}: ScheduleCreateInlineProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [targetId, setTargetId] = React.useState(targets[0]?.id ?? '');
  const [volume, setVolume] = React.useState(`${stack}_`);
  const [every, setEvery] = React.useState('1');
  const [unit, setUnit] = React.useState<Unit>('days');

  const create = useMutation(
    trpc.schedules.create.mutationOptions({
      onSuccess: () => {
        toast.success('Schedule created');
        setVolume(`${stack}_`);
        onDone();
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <div className="bg-accent/40 grid gap-3 border-t px-6 py-5 sm:grid-cols-2">
      <Field label="Volume">
        <Input
          value={volume}
          onChange={(e) => setVolume(e.target.value)}
          placeholder={`${stack}_postgres-data`}
        />
      </Field>
      <Field label="Destination">
        <Select value={targetId} onValueChange={setTargetId}>
          <SelectTrigger>
            <SelectValue placeholder="Pick a destination" />
          </SelectTrigger>
          <SelectContent>
            {targets.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Every">
          <Input type="number" min={1} value={every} onChange={(e) => setEvery(e.target.value)} />
        </Field>
        <Field label="Unit">
          <Select value={unit} onValueChange={(v) => setUnit(v as Unit)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="minutes">Minutes</SelectItem>
              <SelectItem value="hours">Hours</SelectItem>
              <SelectItem value="days">Days</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>
      <div className="flex items-end justify-end">
        <Button
          size="sm"
          className="rounded-full font-bold"
          disabled={
            create.isPending || !targetId || volume.trim() === `${stack}_` || Number(every) < 1
          }
          onClick={() =>
            create.mutate({ targetId, volume: volume.trim(), every: Number(every), unit })
          }
        >
          {create.isPending ? 'Creating…' : 'Create schedule'}
        </Button>
      </div>
    </div>
  );
}
