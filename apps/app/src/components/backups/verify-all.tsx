import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
} from '@swarmy/ui';
import { TONE_TEXT, Tech } from '@/components/calm';
import { formatDurationMs } from '@/components/resilience/format';
import { useTRPC } from '@/integrations/trpc';

interface Outcome {
  name: string;
  ok: boolean;
  detail: string;
  ms: number | null;
}

/**
 * "Verify all": the backup-verify drill (`resilience.runBackupVerify`,
 * `restic check`, read-only) against every destination in turn, each one an
 * audited drill row, with the outcome per destination.
 */
export function VerifyAll(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const targets = useQuery(trpc.backups.listTargets.queryOptions());
  const verify = useMutation(trpc.resilience.runBackupVerify.mutationOptions());
  const [open, setOpen] = React.useState(false);
  const [running, setRunning] = React.useState<string | null>(null);
  const [results, setResults] = React.useState<Outcome[]>([]);
  const list = (targets.data ?? []).filter((t) => t.enabled);

  const runAll = async (): Promise<void> => {
    setOpen(false);
    setResults([]);
    for (const t of list) {
      setRunning(t.name);
      try {
        const r = await verify.mutateAsync({ targetId: t.id });
        const ok = r.status === 'passed';
        setResults((xs) => [...xs, { name: t.name, ok, detail: r.error ?? r.summary, ms: r.durationMs }]);
      } catch (e) {
        setResults((xs) => [...xs, { name: t.name, ok: false, detail: e instanceof Error ? e.message : String(e), ms: null }]);
      }
    }
    setRunning(null);
    void qc.invalidateQueries();
  };

  return (
    <div className="flex flex-col gap-1.5">
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogTrigger asChild>
          <Button variant="outline" size="sm" disabled={list.length === 0 || running != null} className="w-fit pointer-coarse:min-h-11">
            {running ? `Checking ${running}…` : 'Verify all'}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Check every destination?</AlertDialogTitle>
            <AlertDialogDescription>
              Reads every save in each of your {list.length} destination{list.length === 1 ? '' : 's'}, one at a time, to prove
              they are whole. Read-only and safe any time; each check is audited.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void runAll()}>Check {list.length}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {results.map((r) => (
        <div key={r.name} className="flex flex-col text-[13px]">
          <span>
            <b className="font-semibold">{r.name}</b> ·{' '}
            <span className={TONE_TEXT[r.ok ? 'ok' : 'bad']}>{r.ok ? 'every save is whole' : r.ms == null ? 'couldn’t check' : 'the check failed'}</span>
            {r.ms != null ? <span className="text-muted-foreground font-mono text-[11.5px]"> · {formatDurationMs(r.ms)}</span> : null}
          </span>
          <Tech>{r.detail}</Tech>
        </div>
      ))}
    </div>
  );
}
