import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PauseIcon, PlayIcon, Trash2Icon } from 'lucide-react';
import { Badge, Button, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

export function SchedulesTable(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const schedules = useQuery(trpc.schedules.list.queryOptions());

  const setPaused = useMutation(
    trpc.schedules.setPaused.mutationOptions({
      onSuccess: () => qc.invalidateQueries(),
      onError: (e) => toast.error(e.message),
    }),
  );
  const remove = useMutation(
    trpc.schedules.remove.mutationOptions({
      onSuccess: () => {
        toast.success('Schedule removed');
        qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const rows = schedules.data ?? [];
  if (rows.length === 0) {
    return (
      <div className="text-muted-foreground px-6 py-12 text-center text-sm">
        No schedules yet. Create one to back up a volume automatically.
      </div>
    );
  }

  return (
    <div className="border-t">
      {rows.map((s) => (
        <div
          key={s.id}
          className="hover:bg-accent/60 flex items-center justify-between gap-4 border-b px-6 py-3 transition-colors last:border-b-0"
        >
          <div className="min-w-0">
            <p className="font-medium">{s.volume}</p>
            <p className="text-muted-foreground mono-label truncate">
              every {s.every} {s.unit}
              {s.nextRunAt ? ` · next ${new Date(s.nextRunAt).toLocaleString()}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={s.paused ? 'muted' : 'default'}>{s.paused ? 'paused' : 'active'}</Badge>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setPaused.mutate({ id: s.id, paused: !s.paused })}
            >
              {s.paused ? <PlayIcon className="size-4" /> : <PauseIcon className="size-4" />}
            </Button>
            <Button variant="ghost" size="icon" onClick={() => remove.mutate({ id: s.id })}>
              <Trash2Icon className="size-4" />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
