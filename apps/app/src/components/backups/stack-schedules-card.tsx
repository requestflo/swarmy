import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClockIcon, HistoryIcon, PauseIcon, PlayIcon, PlusIcon } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  EmptyState,
  StatusBadge,
  cn,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { untilTime } from './backup-format';
import { RemoveScheduleConfirm } from './remove-schedule-confirm';
import { ScheduleCreateInline } from './schedule-create-inline';
import type { TargetOption } from './target-option';

export interface ScheduleRow {
  id: string;
  volume: string;
  every: number;
  unit: string;
  paused: boolean;
  nextRunAt: string | null;
}

interface StackSchedulesCardProps {
  stack: string;
  schedules: ScheduleRow[];
  targets: TargetOption[];
}

/** This stack's recurring backups — create expands inline, delete confirms. */
export function StackSchedulesCard({
  stack,
  schedules,
  targets,
}: StackSchedulesCardProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [creating, setCreating] = React.useState(false);

  const setPaused = useMutation(
    trpc.schedules.setPaused.mutationOptions({
      onSuccess: () => qc.invalidateQueries(),
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Card className="card-pop border-0">
      <CardContent className="p-0">
        <Collapsible open={creating} onOpenChange={setCreating}>
          <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
            <span className="mono-label">Schedules</span>
            <CollapsibleTrigger asChild>
              <Button
                size="sm"
                className="rounded-full font-bold shadow-[0_8px_24px_-8px_var(--primary)] transition-transform hover:scale-[1.03]"
                disabled={targets.length === 0}
              >
                <PlusIcon className="size-4" /> New schedule
              </Button>
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent>
            <ScheduleCreateInline stack={stack} targets={targets} onDone={() => setCreating(false)} />
          </CollapsibleContent>
        </Collapsible>
        <RetentionRow stack={stack} />
        {schedules.length === 0 ? (
          <div className="border-t px-6 py-2">
            <EmptyState
              className="border-0"
              icon={<CalendarClockIcon />}
              title="Nothing runs on a schedule yet."
              description={`Create one and ${stack}'s volumes back themselves up — swarmy handles the rest.`}
            />
          </div>
        ) : (
          <div className="divide-border divide-y border-t">
            {schedules.map((s) => (
              <div
                key={s.id}
                className={cn(
                  'hover:bg-accent/60 flex items-center gap-4 px-6 py-3 transition-colors',
                  !s.paused && 'border-l-primary border-l-[3px] pl-[21px]',
                )}
              >
                <div className="min-w-0 flex-1">
                  <p className="mono-data truncate font-medium">{s.volume}</p>
                  <p className="text-muted-foreground mono-label truncate">
                    every {s.every} {s.unit} · next {untilTime(s.nextRunAt)}
                  </p>
                </div>
                <StatusBadge
                  tone={s.paused ? 'neutral' : 'online'}
                  label={s.paused ? 'paused' : 'active'}
                />
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={s.paused ? 'Resume schedule' : 'Pause schedule'}
                    disabled={setPaused.isPending}
                    onClick={() => setPaused.mutate({ id: s.id, paused: !s.paused })}
                  >
                    {s.paused ? <PlayIcon className="size-4" /> : <PauseIcon className="size-4" />}
                  </Button>
                  <RemoveScheduleConfirm id={s.id} volume={s.volume} />
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** The stack's retention window (`swarmy.backup.retentionDays` label): after each
 *  successful backup, snapshots older than this are forgotten + pruned. */
function RetentionRow({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const retention = useQuery(trpc.backups.stackRetention.queryOptions({ stack }));
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState('');

  const save = useMutation(
    trpc.backups.setStackRetention.mutationOptions({
      onSuccess: (_r, vars) => {
        toast.success(
          vars.retentionDays
            ? `Snapshots kept ${vars.retentionDays} days — older ones prune after each backup`
            : 'Retention cleared — snapshots are kept forever',
        );
        setEditing(false);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const days = retention.data?.retentionDays ?? null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t px-6 py-3">
      <span className="text-muted-foreground mono-label inline-flex items-center gap-2">
        <HistoryIcon className="size-4" /> Retention
      </span>
      {editing ? (
        <span className="inline-flex items-center gap-2">
          <input
            type="number"
            min={1}
            max={3650}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="days"
            className="border-input bg-background h-7 w-20 rounded-md border px-2 text-sm"
          />
          <Button
            size="sm"
            className="h-7"
            disabled={save.isPending}
            onClick={() => {
              const n = Number(draft);
              save.mutate({ stack, retentionDays: Number.isInteger(n) && n >= 1 ? n : null });
            }}
          >
            Save
          </Button>
          <Button size="sm" variant="ghost" className="h-7" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </span>
      ) : (
        <span className="inline-flex items-center gap-2">
          <span className="mono-data text-sm">{days ? `keep ${days} days` : 'keep forever'}</span>
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            onClick={() => {
              setDraft(days ? String(days) : '30');
              setEditing(true);
            }}
          >
            Edit
          </Button>
        </span>
      )}
    </div>
  );
}
