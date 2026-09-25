import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PencilIcon, PlayIcon, Trash2Icon } from 'lucide-react';
import { Button, EmptyState, cn } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CardSkeleton, ErrorState } from '@/components/states';
import { StudioResult } from './studio-result';
import { useStudioRun } from './use-studio-run';
import { CLASS_TONE, verdictFor } from './studio-verdict';
import type { StudioScope } from './studio-types';

/** Saved queries of this app for this database's engine: run, open in the console, delete. */
export function StudioSaved({ scope, onEdit }: { scope: StudioScope; onEdit: (statement: string) => void }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const list = useQuery(trpc.studio.saved.list.queryOptions({ stack: scope.stack }));
  const [ran, setRan] = React.useState<string | null>(null);
  const { run, dialog, result, running } = useStudioRun(scope);
  const remove = useMutation(
    trpc.studio.saved.remove.mutationOptions({ onSuccess: () => qc.invalidateQueries({ queryKey: trpc.studio.saved.list.queryKey({ stack: scope.stack }) }) }),
  );
  if (list.isPending) return <CardSkeleton />;
  if (list.isError) return <ErrorState error={list.error} retry={() => void list.refetch()} />;
  const rows = list.data.filter((q) => q.engine === scope.target.engine && (q.target === null || q.target === scope.target.name));
  if (rows.length === 0) {
    return <EmptyState title="No saved queries yet" description="Write one in the console and hit Save query — everyone who can read this database sees it here." />;
  }
  return (
    <div className="grid min-h-0 gap-4 lg:grid-cols-[22rem_1fr]">
      <ul className="space-y-2">
        {rows.map((q) => {
          const v = verdictFor(scope.target.engine, q.statement);
          return (
            <li key={q.id} className={cn('calm-card shadow-none flex items-center gap-2 border-0 px-3 py-2.5', ran === q.id && 'ring-primary/50 ring-1')}>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{q.name}</p>
                <p className="text-muted-foreground truncate font-mono text-[11px]">{q.statement}</p>
              </div>
              <span className={cn('rounded-full px-1.5 py-0.5 font-mono text-[10px]', CLASS_TONE[v.classification.class])}>{v.classification.class}</span>
              <Button size="icon" variant="ghost" aria-label={`Open ${q.name} in the console`} onClick={() => onEdit(q.statement)}>
                <PencilIcon className="size-3.5" />
              </Button>
              <Button size="icon" variant="ghost" aria-label={`Delete ${q.name}`} onClick={() => remove.mutate({ stack: scope.stack, id: q.id })}>
                <Trash2Icon className="size-3.5" />
              </Button>
              <Button size="sm" variant="outline" disabled={running} onClick={() => { setRan(q.id); run(q.statement, 'saved'); }}>
                <PlayIcon className="size-3.5" /> Run
              </Button>
            </li>
          );
        })}
      </ul>
      <div className="min-w-0">{result ? <StudioResult result={result} name={scope.target.name} /> : <p className="text-muted-foreground text-sm">Run a saved query to see its rows here.</p>}</div>
      {dialog}
    </div>
  );
}
