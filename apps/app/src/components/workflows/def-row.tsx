import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDownIcon, PlayIcon } from 'lucide-react';
import type { WorkflowDefView } from '@swarmy/core';
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  StatusBadge,
  Switch,
  cn,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { relTime } from '@/lib/format';
import { WorkflowBuilderInline } from './workflow-builder-inline';
import { RUN_STATUS_META, STEP_KIND_LABEL } from './workflow-status';

/** One workflow definition as a flat row — expands inline to the builder (edit = new version). */
export function DefRow({ stack, def }: { stack: string; def: WorkflowDefView }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const invalidate = (): void => void qc.invalidateQueries();

  const trigger = useMutation(
    trpc.workflows.trigger.mutationOptions({
      onSuccess: () => {
        toast.success('Run started');
        invalidate();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const setEnabled = useMutation(
    trpc.workflows.setEnabled.mutationOptions({ onSuccess: invalidate, onError: (e) => toast.error(e.message) }),
  );
  const remove = useMutation(
    trpc.workflows.remove.mutationOptions({
      onSuccess: () => {
        toast.success('Workflow deleted');
        invalidate();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="flex flex-wrap items-center gap-3 px-2 py-3">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex min-w-0 flex-1 basis-48 items-center gap-2 text-left"
            aria-label={`${open ? 'Collapse' : 'Expand'} workflow ${def.name}`}
          >
            <ChevronDownIcon
              className={cn('text-muted-foreground size-4 shrink-0 transition-transform', open && 'rotate-180')}
            />
            <span className="min-w-0">
              <span className="mono-data block truncate text-sm font-semibold">
                {def.name} <span className="text-muted-foreground font-normal">v{def.version}</span>
              </span>
              <span className="text-muted-foreground block truncate text-xs">
                {def.steps.map((s) => STEP_KIND_LABEL[s.kind]).join(' → ')}
              </span>
            </span>
          </button>
        </CollapsibleTrigger>
        <div className="hidden w-40 sm:block">
          {def.lastRunStatus ? (
            <>
              <StatusBadge tone={RUN_STATUS_META[def.lastRunStatus].tone} label={RUN_STATUS_META[def.lastRunStatus].label} />
              <p className="text-muted-foreground mt-0.5 text-xs">{relTime(def.lastRunAt)}</p>
            </>
          ) : (
            <p className="text-muted-foreground text-xs">never run</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Switch
            checked={def.enabled}
            disabled={setEnabled.isPending}
            onCheckedChange={(enabled) => setEnabled.mutate({ name: def.name, enabled })}
            aria-label={def.enabled ? 'Disable workflow' : 'Enable workflow'}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={!def.enabled || trigger.isPending}
            onClick={() => trigger.mutate({ defId: def.id })}
          >
            <PlayIcon className="size-3.5" /> Run
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="sm" className="text-status-offline">
                Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {def.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  Removes all {def.versions} version{def.versions === 1 ? '' : 's'} and its run history.
                  This can&apos;t be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  disabled={remove.isPending}
                  onClick={() => remove.mutate({ name: def.name })}
                >
                  {remove.isPending ? 'Deleting…' : 'Delete workflow'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
      <CollapsibleContent>
        <div className="border-border bg-muted/10 mx-2 mb-3 rounded-lg border p-4">
          <WorkflowBuilderInline stack={stack} editing={def} onDone={() => setOpen(false)} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
