import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ScheduledJobView } from '@swarmy/core';
import { Button, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { EMPTY_DRAFT, toDraft, toInput, type JobDraft } from './job-draft';
import { JobFormAdvanced } from './job-form-advanced';
import { JobFormFields } from './job-form-fields';

/**
 * Create/edit form, inline (a Collapsible parent supplies the expand/collapse
 * chrome). `job` set = edit mode; unset = create, scoped to `stack`.
 */
export function JobEditInline({
  stack,
  job,
  onDone,
}: {
  stack: string;
  job: ScheduledJobView | null;
  onDone: () => void;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [draft, setDraft] = React.useState<JobDraft>(() => (job ? toDraft(job) : EMPTY_DRAFT));

  const done = (message: string): void => {
    toast.success(message);
    void qc.invalidateQueries();
    onDone();
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
      create.mutate({ ...input, stackName: stack });
    }
  };

  const busy = create.isPending || update.isPending;
  const incomplete =
    !draft.name.trim() ||
    !draft.schedule.trim() ||
    !draft.command.trim() ||
    (draft.kind === 'image' ? !draft.image.trim() : !draft.serviceRef.trim());

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-xs">
        {job
          ? 'Changes apply from the next run.'
          : "swarmy runs it on your nodes on schedule — output and history land right here."}
      </p>
      <JobFormFields draft={draft} onChange={setDraft} nameLocked={Boolean(job)} />
      <JobFormAdvanced draft={draft} onChange={setDraft} />
      <div className="flex justify-end">
        <Button onClick={submit} disabled={busy || incomplete}>
          {busy ? 'Saving…' : job ? 'Save changes' : 'Schedule job'}
        </Button>
      </div>
    </div>
  );
}
