import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ScheduledJobView } from '@swarmy/core';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { EMPTY_DRAFT, toDraft, toInput, type JobDraft } from './job-draft';
import { JobFormAdvanced } from './job-form-advanced';
import { JobFormFields } from './job-form-fields';

/** Create/edit dialog — `job` set = edit mode. */
export function JobDialog({
  open,
  onOpenChange,
  job,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  job: ScheduledJobView | null;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [draft, setDraft] = React.useState<JobDraft>(EMPTY_DRAFT);

  React.useEffect(() => {
    if (open) setDraft(job ? toDraft(job) : EMPTY_DRAFT);
  }, [open, job]);

  const done = (message: string): void => {
    toast.success(message);
    void qc.invalidateQueries();
    onOpenChange(false);
  };
  const create = useMutation(
    trpc.jobs.create.mutationOptions({
      onSuccess: (j) => done(`Job ${j.name} scheduled — ${j.scheduleText}`),
      onError: (e) => toast.error(e.message),
    }),
  );
  const update = useMutation(
    trpc.jobs.update.mutationOptions({
      onSuccess: (j) => done(`Job ${j.name} updated`),
      onError: (e) => toast.error(e.message),
    }),
  );

  const submit = (): void => {
    const input = toInput(draft);
    if (job) {
      const { enabled: _keep, ...patch } = input;
      update.mutate({ id: job.id, ...patch });
    } else {
      create.mutate(input);
    }
  };

  const busy = create.isPending || update.isPending;
  const incomplete =
    !draft.name.trim() ||
    !draft.schedule.trim() ||
    !draft.command.trim() ||
    (draft.kind === 'image' ? !draft.image.trim() : !draft.serviceRef.trim());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{job ? `Edit ${job.name}` : 'New scheduled job'}</DialogTitle>
          <DialogDescription>
            {job
              ? 'Changes apply from the next run.'
              : 'swarmy runs it on your nodes on schedule — output and history land on this page.'}
          </DialogDescription>
        </DialogHeader>
        <JobFormFields draft={draft} onChange={setDraft} nameLocked={Boolean(job)} />
        <JobFormAdvanced draft={draft} onChange={setDraft} />
        <DialogFooter>
          <Button onClick={submit} disabled={busy || incomplete}>
            {busy ? 'Saving…' : job ? 'Save changes' : 'Schedule job'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
