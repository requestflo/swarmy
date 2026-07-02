import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MoreVerticalIcon, PlayIcon } from 'lucide-react';
import type { WorkflowDefView } from '@swarmy/core';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  StatusBadge,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { relTime } from '@/lib/format';
import { RUN_STATUS_META, STEP_KIND_LABEL } from './workflow-status';

/** Flat definition rows: steps at a glance, last run, run/edit/manage actions. */
export function DefsList({
  defs,
  onEdit,
}: {
  defs: WorkflowDefView[];
  onEdit: (def: WorkflowDefView) => void;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
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
    <div className="divide-border divide-y">
      {defs.map((def) => (
        <div key={def.name} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
          <div className="min-w-0 flex-1 basis-48">
            <p className="mono-data truncate text-sm font-semibold">
              {def.name} <span className="text-muted-foreground font-normal">v{def.version}</span>
            </p>
            <p className="text-muted-foreground truncate text-xs">
              {def.steps.map((s) => STEP_KIND_LABEL[s.kind]).join(' → ')}
            </p>
          </div>
          <div className="hidden w-40 sm:block">
            {def.lastRunStatus ? (
              <>
                <StatusBadge
                  tone={RUN_STATUS_META[def.lastRunStatus].tone}
                  label={RUN_STATUS_META[def.lastRunStatus].label}
                />
                <p className="text-muted-foreground mt-0.5 text-xs">{relTime(def.lastRunAt)}</p>
              </>
            ) : (
              <p className="text-muted-foreground text-xs">never run</p>
            )}
          </div>
          {!def.enabled ? <StatusBadge tone="neutral" label="disabled" /> : null}
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={!def.enabled || trigger.isPending}
              onClick={() => trigger.mutate({ defId: def.id })}
            >
              <PlayIcon className="size-3.5" /> Run
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={`Manage ${def.name}`}>
                  <MoreVerticalIcon className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => onEdit(def)}>Edit (new version)</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setEnabled.mutate({ name: def.name, enabled: !def.enabled })}>
                  {def.enabled ? 'Disable' : 'Enable'}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-status-offline"
                  onSelect={() => remove.mutate({ name: def.name })}
                >
                  Delete ({def.versions} version{def.versions === 1 ? '' : 's'} + history)
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      ))}
    </div>
  );
}
