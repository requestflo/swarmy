import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

type Unit = 'minutes' | 'hours' | 'days';

interface TargetOption {
  id: string;
  name: string;
}

export function CreateScheduleDialog({ targets }: { targets: TargetOption[] }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [targetId, setTargetId] = React.useState(targets[0]?.id ?? '');
  const [volume, setVolume] = React.useState('');
  const [every, setEvery] = React.useState('1');
  const [unit, setUnit] = React.useState<Unit>('days');

  const create = useMutation(
    trpc.schedules.create.mutationOptions({
      onSuccess: () => {
        toast.success('Schedule created');
        setOpen(false);
        setVolume('');
        qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" disabled={targets.length === 0}>
          <PlusIcon className="size-4" /> New schedule
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Scheduled backup</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <Field label="Target">
            <Select value={targetId} onValueChange={setTargetId}>
              <SelectTrigger>
                <SelectValue placeholder="Pick a target" />
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
          <Field label="Volume">
            <Input value={volume} onChange={(e) => setVolume(e.target.value)} placeholder="postgres-data" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Every">
              <Input
                type="number"
                min={1}
                value={every}
                onChange={(e) => setEvery(e.target.value)}
              />
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
        </div>
        <DialogFooter>
          <Button
            disabled={create.isPending || !targetId || !volume || Number(every) < 1}
            onClick={() =>
              create.mutate({ targetId, volume, every: Number(every), unit })
            }
          >
            Create schedule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="grid gap-1.5">
      <Label className="mono-label">{label}</Label>
      {children}
    </div>
  );
}
