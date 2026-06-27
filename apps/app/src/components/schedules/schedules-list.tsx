import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClockIcon, PauseIcon, PlayIcon, Trash2Icon } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  StatusBadge,
  cn,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/** Data → backup schedules as flat hairline rows in a single card-pop. */
export function SchedulesList(): React.JSX.Element {
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

  return (
    <Card className="card-pop border-0">
      <CardHeader>
        <CardTitle className="text-base">Schedules</CardTitle>
        <CardDescription>Recurring backups, driven by the scheduler worker.</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <div className="px-6 pb-6">
            <EmptyState
              icon={<CalendarClockIcon />}
              title="No schedules yet"
              description="Add one to back up a volume automatically — swarmy handles the rest, on the cadence you set."
              className="border-0"
            />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-[1fr_auto] gap-x-4 px-6 pb-2 sm:grid-cols-[2fr_1.5fr_auto_auto]">
              <span className="mono-label">Volume</span>
              <span className="mono-label hidden sm:block">Next run</span>
              <span className="mono-label hidden sm:block">State</span>
              <span className="mono-label text-right">{rows.length}</span>
            </div>
            <div className="border-t">
              {rows.map((s) => (
                <div
                  key={s.id}
                  className={cn(
                    'group hover:bg-accent/60 grid grid-cols-[1fr_auto] items-center gap-x-4 border-b px-6 py-3 transition-colors last:border-b-0 sm:grid-cols-[2fr_1.5fr_auto_auto]',
                    !s.paused && 'bg-accent/40 border-l-[3px] border-l-primary pl-[21px]',
                  )}
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{s.volume}</p>
                    <p className="text-muted-foreground mono-label truncate">
                      every {s.every} {s.unit}
                      {s.nextRunAt ? (
                        <span className="sm:hidden">
                          {' '}
                          · next {new Date(s.nextRunAt).toLocaleString()}
                        </span>
                      ) : null}
                    </p>
                  </div>
                  <span className="mono-data text-muted-foreground hidden truncate sm:block">
                    {s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : '—'}
                  </span>
                  <div className="hidden sm:flex">
                    <StatusBadge
                      tone={s.paused ? 'neutral' : 'online'}
                      label={s.paused ? 'paused' : 'active'}
                    />
                  </div>
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={s.paused ? 'Resume schedule' : 'Pause schedule'}
                      onClick={() => setPaused.mutate({ id: s.id, paused: !s.paused })}
                    >
                      {s.paused ? <PlayIcon className="size-4" /> : <PauseIcon className="size-4" />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Remove schedule"
                      className="text-status-offline hover:text-status-offline"
                      onClick={() => remove.mutate({ id: s.id })}
                    >
                      <Trash2Icon className="size-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
