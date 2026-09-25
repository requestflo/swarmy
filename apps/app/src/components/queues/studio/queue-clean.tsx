import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SparklesIcon } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { STUDIO_STATES, stateCount, type StudioQueue, type StudioRef, type StudioState } from './studio-types';

const CLEANABLE: StudioState[] = ['completed', 'failed', 'wait', 'delayed', 'prioritized', 'paused'];
const GRACE: { label: string; ms: number }[] = [
  { label: 'all', ms: 0 },
  { label: 'older than 1h', ms: 3_600_000 },
  { label: 'older than 24h', ms: 86_400_000 },
  { label: 'older than 7d', ms: 7 * 86_400_000 },
];

/** Clean the jobs in the selected state (confirmed; up to 1,000 at a time). */
export function QueueCleanBar({ studio, queue, state }: { studio: StudioRef; queue: StudioQueue; state: StudioState }): React.JSX.Element | null {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [grace, setGrace] = React.useState('0');
  const ref = { ...studio, queue: queue.name };
  const clean = useMutation(
    trpc.queues.studioClean.mutationOptions({
      onSuccess: (r) => {
        toast.success(r.message);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  if (!CLEANABLE.includes(state) || stateCount(queue, state) === 0) return null;
  return (
    <div className="border-border flex flex-wrap items-center gap-2 border-t pt-4">
      <SparklesIcon className="text-muted-foreground size-4" />
      <p className="text-sm">Clean {STUDIO_STATES.find((s) => s.id === state)?.label.toLowerCase()} jobs</p>
      <Select value={grace} onValueChange={setGrace}>
        <SelectTrigger aria-label="Which jobs to clean" className="h-8 w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {GRACE.map((g) => (
            <SelectItem key={g.ms} value={String(g.ms)}>
              {g.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            className="text-tone-bad border-status-offline/40 hover:bg-status-offline/10"
            disabled={clean.isPending}
          >
            Clean
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {state} jobs on {queue.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Removes up to 1,000 jobs (and their data and logs) in this state
              {grace !== '0' ? `, ${GRACE.find((g) => String(g.ms) === grace)?.label}` : ''}. This can’t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                clean.mutate({
                  ...ref,
                  state: state as 'completed' | 'failed' | 'wait' | 'delayed' | 'prioritized' | 'paused',
                  graceMs: Number(grace),
                  limit: 1000,
                })
              }
            >
              Clean
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
